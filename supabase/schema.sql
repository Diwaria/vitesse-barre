-- Vitesse de barre : coach / joueurs
-- Rôles : un coach crée une équipe (code d'invitation) ; les joueurs la rejoignent avec ce code.

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  coach_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  role text not null default 'player' check (role in ('coach','player')),
  team_id uuid references public.teams(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Séances programmées par le coach (pour toute l'équipe ou un joueur)
create table if not exists public.planned_sessions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  player_id uuid references public.profiles(id) on delete cascade,  -- null = toute l'équipe
  day date not null,
  title text not null default '',
  exercises jsonb not null default '[]',  -- [{exo, sets, load, vloss, metric}]
  created_at timestamptz not null default now()
);

-- Séries réalisées par les joueurs
create table if not exists public.sets (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.profiles(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  planned_id uuid references public.planned_sessions(id) on delete set null,
  session_key text not null,           -- regroupe les séries d'une même séance
  exo text not null,
  load_kg numeric,
  set_index int not null,
  metric text not null default 'mcv',
  vloss_target numeric,
  reps jsonb not null default '[]',    -- [{mcv, mpv, peak, rom, dur}]
  best numeric, last numeric, loss numeric,
  video_path text,                     -- rempli quand la vidéo a été envoyée
  video_requested boolean not null default false,
  performed_at timestamptz not null default now()
);
create index if not exists sets_player_time on public.sets(player_id, performed_at desc);
create index if not exists sets_team_time on public.sets(team_id, performed_at desc);

-- Fonctions utilitaires (security definer : évitent la récursion des règles d'accès)
create or replace function public.my_team() returns uuid language sql stable security definer set search_path = public as
$$ select team_id from public.profiles where id = auth.uid() $$;
create or replace function public.is_coach_of(t uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from public.teams where id = t and coach_id = auth.uid()) $$;

-- Profil créé automatiquement à l'inscription
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, name) values (new.id, coalesce(new.raw_user_meta_data->>'name', ''));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Le coach crée son équipe : renvoie le code d'invitation
create or replace function public.create_team(team_name text) returns text language plpgsql security definer set search_path = public as $$
declare c text; t uuid;
begin
  c := upper(substr(md5(random()::text), 1, 6));
  insert into public.teams(name, code, coach_id) values (team_name, c, auth.uid()) returning id into t;
  update public.profiles set role = 'coach', team_id = t where id = auth.uid();
  return c;
end $$;

-- Le joueur rejoint une équipe avec le code
create or replace function public.join_team(team_code text) returns text language plpgsql security definer set search_path = public as $$
declare t uuid; n text;
begin
  select id, name into t, n from public.teams where code = upper(trim(team_code));
  if t is null then raise exception 'Code inconnu'; end if;
  update public.profiles set team_id = t, role = 'player' where id = auth.uid() and role = 'player';
  return n;
end $$;

alter table public.teams enable row level security;
alter table public.profiles enable row level security;
alter table public.planned_sessions enable row level security;
alter table public.sets enable row level security;

-- Équipes : le coach gère la sienne, les joueurs voient la leur
drop policy if exists teams_read on public.teams;
create policy teams_read on public.teams for select using (coach_id = auth.uid() or id = public.my_team());
drop policy if exists teams_coach on public.teams;
create policy teams_coach on public.teams for update using (coach_id = auth.uid());

-- Profils : chacun le sien ; le coach voit ceux de son équipe
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select using (id = auth.uid() or public.is_coach_of(team_id));
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update using (id = auth.uid()) with check (id = auth.uid() and role = (select role from public.profiles p where p.id = auth.uid()) and team_id is not distinct from public.my_team());

-- Séances programmées : le coach écrit, les joueurs concernés lisent
drop policy if exists planned_coach on public.planned_sessions;
create policy planned_coach on public.planned_sessions for all using (public.is_coach_of(team_id)) with check (public.is_coach_of(team_id));
drop policy if exists planned_player on public.planned_sessions;
create policy planned_player on public.planned_sessions for select using (team_id = public.my_team() and (player_id is null or player_id = auth.uid()));

-- Séries : le joueur écrit et lit les siennes ; le coach lit celles de son équipe et peut demander une vidéo
drop policy if exists sets_player_rw on public.sets;
create policy sets_player_rw on public.sets for all using (player_id = auth.uid()) with check (player_id = auth.uid() and team_id = public.my_team());
drop policy if exists sets_coach_read on public.sets;
create policy sets_coach_read on public.sets for select using (public.is_coach_of(team_id));
drop policy if exists sets_coach_request on public.sets;
create policy sets_coach_request on public.sets for update using (public.is_coach_of(team_id)) with check (public.is_coach_of(team_id));

-- Vidéos : stockage privé, dossier <équipe>/<joueur>/<série>.mp4
insert into storage.buckets (id, name, public) values ('videos', 'videos', false) on conflict (id) do nothing;
drop policy if exists videos_player_write on storage.objects;
create policy videos_player_write on storage.objects for insert with check (
  bucket_id = 'videos' and (storage.foldername(name))[1] = public.my_team()::text and (storage.foldername(name))[2] = auth.uid()::text);
drop policy if exists videos_read on storage.objects;
create policy videos_read on storage.objects for select using (
  bucket_id = 'videos' and ((storage.foldername(name))[2] = auth.uid()::text or public.is_coach_of(((storage.foldername(name))[1])::uuid)));
