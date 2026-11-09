-- Carnet de Fonte : comptes séparés
-- À coller une seule fois dans Supabase > SQL Editor > New query, puis "Run".
-- Chaque ligne appartient à un compte ; la base refuse qu'un compte lise ou modifie les lignes d'un autre.

create table if not exists public.carnet_docs (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  path text not null,            -- "profile" ou une séance
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);

alter table public.carnet_docs enable row level security;

drop policy if exists "carnet: mes données seulement" on public.carnet_docs;
create policy "carnet: mes données seulement" on public.carnet_docs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
