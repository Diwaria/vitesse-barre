"use strict";
/* Espace coach : code d'équipe, programmation des séances, suivi des séries par semaine, vidéos sur demande */
(function(){
  const main = document.getElementById("main");
  const cfg = window.VB_CONFIG || {};
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const n2 = x => x==null || !isFinite(x) ? "–" : (+x).toFixed(2).replace(".", ",");
  const exName = k => EXOS[k]?.name || k;
  if(!cfg.url || !cfg.key || !window.supabase){ main.innerHTML = `<p class="note">L'espace coach n'est pas encore relié au serveur.</p>`; return; }
  const sb = window.supabase.createClient(cfg.url, cfg.key);
  let user=null, profile=null, team=null, players=[], sets=[], formes=[], jumps=[], perfSets=[], perfPlayer="", sheetPlayer="", plans=[], tab="forme", filterPlayer="", weeks=6;

  function exOptions(sel){
    const cats={}; for(const [k,e] of Object.entries(EXOS)) (cats[e.cat] ||= []).push([k,e]);
    return Object.entries(cats).map(([c,l])=>`<optgroup label="${esc(c)}">${l.map(([k,e])=>`<option value="${k}"${k===sel?" selected":""}>${esc(e.name)}</option>`).join("")}</optgroup>`).join("");
  }
  function weekStart(d){ const x=new Date(d); x.setHours(0,0,0,0); const wd=(x.getDay()+6)%7; x.setDate(x.getDate()-wd); return x; }
  const fmtDay = d => new Date(d).toLocaleDateString("fr-FR",{weekday:"short",day:"numeric",month:"short"});

  function loginView(msg){
    main.innerHTML=`<h2>Connexion coach</h2>
      <div class="grid2"><label class="field"><span class="lbl">E-mail</span><input id="cMail" type="email" autocomplete="email"></label>
      <label class="field"><span class="lbl">Mot de passe</span><input id="cPass" type="password" autocomplete="current-password"></label></div>
      <button type="button" class="primary" id="cLogin">Se connecter</button>
      <p class="note" id="cMsg">${esc(msg||"Pas encore de compte ? Crée-le depuis l'app (Mon compte › Créer un compte), puis « Je suis le coach ».")}</p>`;
    $("cLogin").onclick=async()=>{ const {error}=await sb.auth.signInWithPassword({email:$("cMail").value.trim(),password:$("cPass").value}); if(error) $("cMsg").textContent="E-mail ou mot de passe incorrect."; };
  }

  async function loadData(){
    const since=new Date(Date.now()-weeks*7*864e5).toISOString();
    const [p,s,pl,fm,pf]=await Promise.all([
      sb.from("profiles").select("id,name,role").eq("team_id",team.id).order("name"),
      sb.from("sets").select("*").eq("team_id",team.id).gte("performed_at",since).order("performed_at",{ascending:false}).limit(2000),
      sb.from("planned_sessions").select("*").eq("team_id",team.id).gte("day",new Date(Date.now()-21*864e5).toISOString().slice(0,10)).order("day"),
      sb.from("sets").select("player_id,load_kg,reps,performed_at,session_key").eq("team_id",team.id).like("session_key","forme-%").gte("performed_at",new Date(Date.now()-150*864e5).toISOString()).order("performed_at").limit(3000),
      sb.from("sets").select("player_id,exo,load_kg,reps,performed_at,session_key").eq("team_id",team.id).not("load_kg","is",null).gte("performed_at",new Date(Date.now()-120*864e5).toISOString()).order("performed_at",{ascending:false}).limit(5000)
    ]);
    perfSets=(pf.data||[]).filter(x=>!String(x.session_key).startsWith("forme-") && x.load_kg>0);
    players=(p.data||[]).filter(x=>x.role==="player"); plans=pl.data||[];
    sets=(s.data||[]).filter(x=>!/^(forme|jump)-/.test(String(x.session_key)));
    jumps=(s.data||[]).filter(x=>String(x.session_key).startsWith("jump-"));
    formes=fm.data||[];
  }

  function render(){
    const tabs=[["forme","Forme du jour"],["perf","Performances"],["suivi","Suivi"],["prog","Programmer"],["joueurs",`Joueurs (${players.length})`]];
    main.innerHTML=`<div class="row" style="justify-content:space-between;align-items:baseline"><h2 style="flex:0 1 auto">${esc(team.name)}</h2>
      <button type="button" class="small" id="cOut" style="flex:0 0 auto">Se déconnecter</button></div>
      <div class="tabs" role="tablist">${tabs.map(([k,l])=>`<button type="button" role="tab" aria-selected="${tab===k}" data-tab="${k}">${l}</button>`).join("")}</div>
      <div id="tabBody" class="col"></div>`;
    main.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{ tab=b.dataset.tab; render(); });
    $("cOut").onclick=()=>sb.auth.signOut();
    if(tab==="forme") renderForme(); else if(tab==="perf") renderPerf(); else if(tab==="suivi") renderSuivi(); else if(tab==="prog") renderProg(); else renderPlayers();
  }

  /* ---------- Forme du jour (même calcul que dans l'app joueur) ---------- */
  const FL={ok:"En forme", warn:"Fatigue légère", bad:"Fatigué", build:"Référence en cours"};
  function formeTests(pid){
    // un test par jour (le dernier), meilleure vitesse des 4 premières répétitions
    const byDay=new Map();
    for(const r of formes.filter(f=>f.player_id===pid)){
      const reps=(r.reps||[]).slice(0,4).map(x=>x.mcv).filter(x=>x>0); if(!reps.length) continue;
      const t=new Date(r.performed_at);
      byDay.set(t.toDateString(), {date:t.getTime(), load:r.load_kg, v:Math.max(...reps)});
    }
    const list=[...byDay.values()].sort((a,b)=>a.date-b.date);
    list.forEach((t,i)=>{
      const base=list.slice(0,i).filter(x=>x.load===t.load).slice(-10).map(x=>x.v);
      if(base.length<3){ t.level="build"; return; }
      const m=base.reduce((a,b)=>a+b,0)/base.length; t.m=m; t.diff=(t.v-m)/m*100;
      t.level= t.diff>=-5? "ok" : t.diff>=-10? "warn" : "bad";
    });
    return list;
  }
  function renderForme(){
    const body=$("tabBody"), today=new Date().toDateString();
    const rows=players.map(p=>{ const ts=formeTests(p.id), last=ts[ts.length-1]; return {p, ts, last, isToday: last && new Date(last.date).toDateString()===today}; });
    const order={bad:0,warn:1,ok:2,build:3};
    rows.sort((a,b)=> (b.isToday-a.isToday) || ((order[a.last?.level]??9)-(order[b.last?.level]??9)) );
    const nDone=rows.filter(r=>r.isToday).length, cnt=l=>rows.filter(r=>r.isToday&&r.last.level===l).length;
    body.innerHTML=`<p class="note">Aujourd'hui : ${nDone} joueur(s) testé(s) sur ${players.length} · <span class="fdot ok"></span> ${cnt("ok")} &nbsp;<span class="fdot warn"></span> ${cnt("warn")} &nbsp;<span class="fdot bad"></span> ${cnt("bad")}</p>
      <p class="note">Test : 3 squats sautés à charge fixe après l'échauffement. Vert : normale jusqu'à −5 % ; orange : −5 à −10 % ; rouge : au-delà de −10 % (normale = moyenne des 10 derniers tests à la même charge).</p>
      <div class="tblwrap"><table class="tbl"><thead><tr><th>Joueur</th><th>Dernier test</th><th>État</th><th>Vitesse</th><th>Normale</th><th>Écart</th><th>7 derniers</th></tr></thead><tbody>${
      rows.map(({p,ts,last,isToday})=>`<tr><td><b>${esc(p.name||"Sans nom")}</b></td>${ last ? `<td>${isToday?"<b>Aujourd'hui</b>":fmtDay(last.date)}</td><td><span class="fdot ${last.level}"></span> ${FL[last.level]}</td><td>${n2(last.v)} m/s</td><td>${last.m? n2(last.m):"–"}</td><td>${last.diff!=null? (last.diff>=0?"+":"−")+Math.abs(last.diff).toFixed(1).replace(".",",")+" %":"–"}</td><td><span class="fdots">${ts.slice(-7).map(t=>`<span class="fdot ${t.level}" title="${fmtDay(t.date)} : ${n2(t.v)} m/s"></span>`).join("")}</span></td>`
        : `<td colspan="6" style="color:var(--muted)">aucun test</td>`}</tr>`).join("") || `<tr><td colspan="7">Aucun joueur pour l'instant.</td></tr>`
      }</tbody></table></div>`;
  }

  /* ---------- Performances : 1RM estimé (profil charge-vitesse, même calcul que l'app) ---------- */
  function points(pid, exo, until){
    const since=until-90*864e5, by=new Map();
    for(const r of perfSets){
      const t=new Date(r.performed_at).getTime();
      if(r.player_id!==pid || r.exo!==exo || t<since || t>until) continue;
      const v=Math.max(0,...(r.reps||[]).map(x=>x.mcv||0)); if(!(v>0)) continue;
      const k=Math.round(r.load_kg*10)/10, cur=by.get(k); if(!cur || v>cur.v) by.set(k,{load:k,v});
    }
    return [...by.values()].sort((a,b)=>a.load-b.load);
  }
  function oneRM(pts, mvt){
    if(pts.length<2 || !(mvt>0)) return null;
    const n=pts.length, mx=pts.reduce((s,p)=>s+p.load,0)/n, my=pts.reduce((s,p)=>s+p.v,0)/n;
    let sxx=0,sxy=0,syy=0; for(const p of pts){ sxx+=(p.load-mx)**2; sxy+=(p.load-mx)*(p.v-my); syy+=(p.v-my)**2; }
    if(!sxx) return null; const b=sxy/sxx, a=my-b*mx; if(!(b<0)) return null;
    const rm=(mvt-a)/b; return rm>0? {rm, r2: syy? sxy*sxy/(sxx*syy):0, n} : null;
  }
  function perfFor(pid, exo){
    const now=Date.now(), mvt=EXOS[exo]?.mvt;
    return {now:oneRM(points(pid,exo,now),mvt), before:oneRM(points(pid,exo,now-30*864e5),mvt), pts:points(pid,exo,now)};
  }
  function renderPerf(){
    const body=$("tabBody");
    const exos=Object.keys(EXOS).filter(k=>EXOS[k].mvt && perfSets.some(r=>r.exo===k));
    if(!exos.length){ body.innerHTML=`<p class="note">Pas encore de séries avec une charge sur les 120 derniers jours. Le 1RM estimé apparaît dès qu'un joueur a mesuré au moins 2 charges différentes sur un exercice.</p>`; return; }
    const cell=pr=> pr.now ? `<b>${Math.round(pr.now.rm)} kg</b>${pr.before? ` <span class="${pr.now.rm>=pr.before.rm?"lossok":"lossbad"}">${pr.now.rm>=pr.before.rm?"+":"−"}${Math.round(Math.abs(pr.now.rm-pr.before.rm))}</span>`:""}` : `<span style="color:var(--muted)">–</span>`;
    let html=`<p class="note">1RM estimé à partir des séries des 90 derniers jours (meilleure répétition à chaque charge, vitesse au 1RM de référence). Le chiffre en couleur : évolution sur 1 mois. Touchez un joueur pour le détail.</p>
      <div class="tblwrap"><table class="tbl"><thead><tr><th>Joueur</th>${exos.map(k=>`<th>${esc(EXOS[k].name)}</th>`).join("")}</tr></thead><tbody>${
      players.map(p=>`<tr><td><button type="button" class="small" data-pp="${p.id}">${esc(p.name||"Sans nom")}</button></td>${exos.map(k=>`<td>${cell(perfFor(p.id,k))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    const pl=players.find(p=>p.id===perfPlayer);
    if(pl){
      html+=`<div class="sess"><h3 style="margin:0">${esc(pl.name||"Sans nom")}</h3>${Object.keys(EXOS).filter(k=>perfSets.some(r=>r.player_id===pl.id && r.exo===k)).map(k=>{
        const pr=perfFor(pl.id,k);
        return `<div class="setrow"><span class="k">${esc(EXOS[k].name)}</span><span class="m">${pr.now? `1RM estimé <b>${Math.round(pr.now.rm)} kg</b> (${pr.now.r2>=0.9&&pr.now.n>=4?"fiable":"indicatif"})` : (EXOS[k].mvt? "1RM non estimable (moins de 2 charges)" : "pas de 1RM pour cet exercice")}<br>${pr.pts.slice(-6).map(q=>`${String(q.load).replace(".",",")} kg : ${n2(q.v)}`).join(" · ")}</span><span></span></div>`; }).join("")}</div>`;
    }
    body.innerHTML=html;
    body.querySelectorAll("[data-pp]").forEach(b=>b.onclick=()=>{ perfPlayer = perfPlayer===b.dataset.pp? "" : b.dataset.pp; renderPerf(); });
  }

  /* ---------- Suivi ---------- */
  function spark(points){
    if(points.length<2) return "";
    const W=600,H=120,P=24, xs=points.map(p=>p.t), ys=points.map(p=>p.v);
    const x0=Math.min(...xs), x1=Math.max(...xs), y0=Math.min(...ys)*0.95, y1=Math.max(...ys)*1.05;
    const X=t=>P+(t-x0)/((x1-x0)||1)*(W-2*P), Y=v=>H-P-(v-y0)/((y1-y0)||1)*(H-2*P);
    const d=points.map((p,i)=>(i?"L":"M")+X(p.t).toFixed(1)+" "+Y(p.v).toFixed(1)).join(" ");
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Meilleure vitesse par séance">
      <line x1="${P}" x2="${W-P}" y1="${H-P}" y2="${H-P}" stroke="var(--line)"/>
      <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round"/>
      ${points.map(p=>`<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="5" fill="var(--accent)"><title>${fmtDay(p.t)} : ${n2(p.v)} m/s</title></circle>`).join("")}
      <text x="${P}" y="14" font-size="16" fill="var(--muted)">${n2(y1/1.05)} m/s</text><text x="${P}" y="${H-4}" font-size="16" fill="var(--muted)">${n2(y0/0.95)}</text></svg>`;
  }
  function renderSuivi(){
    const body=$("tabBody");
    const list=sets.filter(s=>!filterPlayer || s.player_id===filterPlayer);
    const pname=id=>players.find(p=>p.id===id)?.name||"Joueur";
    let html=`<div class="grid2"><label class="field"><span class="lbl">Joueur</span><select id="fPl"><option value="">Toute l'équipe</option>${players.map(p=>`<option value="${p.id}"${p.id===filterPlayer?" selected":""}>${esc(p.name||"Sans nom")}</option>`).join("")}</select></label>
      <label class="field"><span class="lbl">Période</span><select id="fWk">${[2,4,6,12].map(w=>`<option value="${w}"${w===weeks?" selected":""}>${w} dernières semaines</option>`).join("")}</select></label></div>`;
    if(!list.length){ body.innerHTML=html+`<p class="note">Aucune série reçue sur cette période. Les séries apparaissent ici dès qu'un joueur les termine.</p>`; bindF(); return; }
    // courbes : meilleure vitesse de chaque séance, par exercice (joueur choisi)
    if(filterPlayer){
      const by={}; for(const s of list){ const k=s.exo; const key=s.session_key; (by[k] ||= {}); const b=by[k][key]; if(!b || s.best>b.v) by[k][key]={t:new Date(s.performed_at).getTime(), v:+s.best}; }
      html+=Object.entries(by).map(([k,m])=>{ const pts=Object.values(m).filter(p=>isFinite(p.v)).sort((a,b)=>a.t-b.t); return pts.length>1? `<div><div class="lbl">${esc(exName(k))} · meilleure vitesse par séance</div>${spark(pts)}</div>` : ""; }).join("");
    }
    // semaines → séances → séries
    const wk={}; for(const s of list){ const w=weekStart(s.performed_at).getTime(); ((wk[w] ||= {})[s.player_id+"|"+s.session_key] ||= []).push(s); }
    for(const w of Object.keys(wk).sort((a,b)=>b-a)){
      const end=new Date(+w+6*864e5);
      html+=`<div class="week"><div class="wk">Semaine du ${new Date(+w).toLocaleDateString("fr-FR",{day:"numeric",month:"short"})} au ${end.toLocaleDateString("fr-FR",{day:"numeric",month:"short"})}</div>`;
      const sessions=Object.values(wk[w]).sort((a,b)=>new Date(b[0].performed_at)-new Date(a[0].performed_at));
      for(const ss of sessions){
        ss.sort((a,b)=>new Date(a.performed_at)-new Date(b.performed_at));
        const rows=ss.map(s=>{
          const hit = s.vloss_target!=null && s.loss!=null && s.loss>=s.vloss_target;
          const vid = s.video_path ? `<button type="button" class="small" data-see="${s.id}">Voir</button>`
                    : s.video_requested ? `<span class="sub">demandée</span>` : `<button type="button" class="small" data-ask="${s.id}">Demander</button>`;
          return `<tr><td>${esc(exName(s.exo))}</td><td>S${s.set_index}</td><td>${s.load_kg!=null? esc(s.load_kg)+" kg":"–"}</td><td>${(s.reps||[]).length}</td><td>${n2(s.best)}</td><td>${n2(s.last)}</td><td class="${hit?"bad":"ok"}">${s.loss!=null? Math.round(s.loss)+" %":"–"}${s.vloss_target!=null?` <span class="sub">/ ${Math.round(s.vloss_target)}</span>`:""}</td><td>${vid}</td></tr>
            <tr hidden data-vrow="${s.id}"><td colspan="8"></td></tr>`;
        }).join("");
        html+=`<div class="sess"><h3>${esc(pname(ss[0].player_id))} · ${fmtDay(ss[0].performed_at)}</h3>
          <div class="tblwrap"><table class="tbl"><thead><tr><th>Exercice</th><th>Série</th><th>Charge</th><th>Rép.</th><th>Meilleure</th><th>Dernière</th><th>Perte / max</th><th>Vidéo</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
      }
      html+=`</div>`;
    }
    body.innerHTML=html; bindF();
    body.querySelectorAll("[data-ask]").forEach(b=>b.onclick=async()=>{ b.disabled=true; const {error}=await sb.from("sets").update({video_requested:true}).eq("id",b.dataset.ask); if(error){ b.disabled=false; b.textContent="Réessayer"; return; } const s=sets.find(x=>x.id===b.dataset.ask); if(s) s.video_requested=true; b.outerHTML=`<span class="sub">demandée</span>`; });
    body.querySelectorAll("[data-see]").forEach(b=>b.onclick=async()=>{
      const s=sets.find(x=>x.id===b.dataset.see); const row=body.querySelector(`[data-vrow="${s.id}"]`);
      if(!row.hidden){ row.hidden=true; row.firstElementChild.innerHTML=""; return; }
      const {data,error}=await sb.storage.from("videos").createSignedUrl(s.video_path, 3600);
      row.hidden=false; row.firstElementChild.innerHTML = error? `<span class="note">Vidéo introuvable.</span>` : `<video src="${data.signedUrl}" controls playsinline></video>`;
    });
  }
  function bindF(){
    $("fPl").onchange=e=>{ filterPlayer=e.target.value; renderSuivi(); };
    $("fWk").onchange=async e=>{ weeks=+e.target.value; await loadData(); renderSuivi(); };
  }

  /* ---------- Programmer ---------- */
  let draft=null;
  function renderProg(){
    draft ||= {day:new Date().toISOString().slice(0,10), title:"", player_id:"", exercises:[{exo:"squat",sets:4,load:"",vloss:20}]};
    const body=$("tabBody");
    const exRows=draft.exercises.map((e,i)=>`<div class="exrow">
      <label class="field"><span class="lbl">Exercice</span><select data-f="exo" data-i="${i}">${exOptions(e.exo)}</select></label>
      <label class="field"><span class="lbl">Séries</span><input data-f="sets" data-i="${i}" type="number" inputmode="numeric" min="1" max="20" value="${esc(e.sets)}"></label>
      <label class="field"><span class="lbl">Charge kg</span><input data-f="load" data-i="${i}" type="number" inputmode="decimal" step="2.5" value="${esc(e.load)}"></label>
      <label class="field"><span class="lbl">Perte max %</span><input data-f="vloss" data-i="${i}" type="number" inputmode="numeric" step="5" value="${esc(e.vloss)}"></label>
      <button type="button" class="small" data-del="${i}" aria-label="Retirer l'exercice"${draft.exercises.length<2?" disabled":""}>✕</button></div>`).join("");
    const up=plans.filter(p=>p.day>=new Date(Date.now()-864e5).toISOString().slice(0,10));
    body.innerHTML=`<div class="grid2">
        <label class="field"><span class="lbl">Date</span><input id="pDay" type="date" value="${draft.day}"></label>
        <label class="field"><span class="lbl">Pour</span><select id="pWho"><option value="">Toute l'équipe</option>${players.map(p=>`<option value="${p.id}"${p.id===draft.player_id?" selected":""}>${esc(p.name||"Sans nom")}</option>`).join("")}</select></label>
        <label class="field" style="grid-column:1/-1"><span class="lbl">Titre</span><input id="pTitle" placeholder="ex. Force bas du corps" value="${esc(draft.title)}"></label>
      </div>
      <div class="col">${exRows}</div>
      <div class="row"><button type="button" id="pAdd">Ajouter un exercice</button><button type="button" class="primary" id="pSave">Enregistrer la séance</button></div>
      <p class="note" id="pMsg"></p>
      <div class="lbl">Séances à venir</div>
      <div class="sets">${up.map(p=>`<div class="setrow"><span class="k">${new Date(p.day+"T12:00").toLocaleDateString("fr-FR",{day:"numeric",month:"short"})}</span>
        <span class="m"><b>${esc(p.title||"Séance")}</b> · ${p.player_id? esc(players.find(x=>x.id===p.player_id)?.name||"joueur") : "toute l'équipe"}<br>${(p.exercises||[]).map(e=>`${esc(exName(e.exo))} ${e.sets}×${e.load? " "+esc(e.load)+" kg":""}${e.vloss? ", perte max "+esc(e.vloss)+" %":""}`).join(" · ")}</span>
        <button type="button" class="small" data-rm="${p.id}">Supprimer</button></div>`).join("") || `<p class="note">Aucune séance programmée.</p>`}</div>`;
    body.querySelectorAll("[data-f]").forEach(el=>el.onchange=()=>{ draft.exercises[+el.dataset.i][el.dataset.f]=el.value; });
    body.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{ draft.exercises.splice(+b.dataset.del,1); renderProg(); });
    $("pDay").onchange=e=>draft.day=e.target.value; $("pWho").onchange=e=>draft.player_id=e.target.value; $("pTitle").oninput=e=>draft.title=e.target.value;
    $("pAdd").onclick=()=>{ const l=draft.exercises[draft.exercises.length-1]; draft.exercises.push({exo:l.exo,sets:l.sets,load:"",vloss:l.vloss}); renderProg(); };
    $("pSave").onclick=async()=>{
      const ex=draft.exercises.map(e=>({exo:e.exo, sets:Math.max(1,parseInt(e.sets)||1), load:e.load===""?null:+String(e.load).replace(",","."), vloss:e.vloss===""?null:+e.vloss}));
      const {error}=await sb.from("planned_sessions").insert({team_id:team.id, player_id:draft.player_id||null, day:draft.day, title:draft.title.trim(), exercises:ex});
      if(error){ $("pMsg").textContent="Enregistrement impossible : "+error.message; return; }
      draft=null; await loadData(); renderProg(); $("pMsg").textContent="Séance enregistrée. Les joueurs la verront dans l'app.";
    };
    body.querySelectorAll("[data-rm]").forEach(b=>b.onclick=async()=>{ if(b.dataset.c!=="1"){ b.dataset.c="1"; b.textContent="Confirmer"; return; } await sb.from("planned_sessions").delete().eq("id",b.dataset.rm); await loadData(); renderProg(); });
  }

  /* ---------- Joueurs ---------- */
  function renderPlayers(){
    const body=$("tabBody"), wk0=weekStart(Date.now()).getTime();
    body.innerHTML=`<div class="sess"><div class="lbl">Code à donner à tes joueurs</div><div class="code">${esc(team.code)}</div>
      <p class="note">Le joueur ouvre l'app, crée son compte (Mon compte), puis entre ce code.</p>
      <button type="button" class="small" id="cpy">Copier le code</button></div>
      <div class="sets">${players.map(p=>{ const ps=sets.filter(s=>s.player_id===p.id); const last=ps[0]?.performed_at; const nWeek=new Set(ps.filter(s=>new Date(s.performed_at).getTime()>=wk0).map(s=>s.session_key)).size;
        return `<div class="setrow"><span class="k">${esc((p.name||"?").slice(0,2).toUpperCase())}</span><span class="m"><b>${esc(p.name||"Sans nom")}</b><br>${last? "dernière séance "+fmtDay(last) : "aucune séance"} · ${nWeek} séance(s) cette semaine</span>
        <span class="row" style="flex:0 0 auto;gap:6px"><button type="button" class="small primary" data-sheet="${p.id}">Fiche</button><button type="button" class="small" data-see="${p.id}">Suivi</button></span></div>${sheetPlayer===p.id? `<div id="sheet" class="sess"></div>`:""}`; }).join("") || `<p class="note">Aucun joueur pour l'instant.</p>`}</div>`;
    $("cpy").onclick=()=>{ navigator.clipboard?.writeText(team.code).then(()=>$("cpy").textContent="Copié",()=>{}); };
    body.querySelectorAll("[data-see]").forEach(b=>b.onclick=()=>{ filterPlayer=b.dataset.see; tab="suivi"; render(); });
    body.querySelectorAll("[data-sheet]").forEach(b=>b.onclick=()=>{ sheetPlayer = sheetPlayer===b.dataset.sheet? "" : b.dataset.sheet; renderPlayers(); $("sheet")?.scrollIntoView({behavior:"smooth",block:"start"}); });
    if(sheetPlayer && $("sheet")) renderSheet(sheetPlayer);
  }
  /* Fiche d'un joueur : forme du jour, 1RM estimés, dernières séries (toutes : séances, mesures rapides, tests) */
  function renderSheet(pid){
    const el=$("sheet"), p=players.find(x=>x.id===pid); if(!el||!p) return;
    const ft=formeTests(pid), last=ft[ft.length-1];
    const forme = last ? `<p class="m"><span class="fdot ${last.level}"></span> <b>${FL[last.level]}</b> · ${fmtDay(last.date)} · ${n2(last.v)} m/s${last.diff!=null? ` (${last.diff>=0?"+":"−"}${Math.abs(last.diff).toFixed(1).replace(".",",")} %)`:""} &nbsp;<span class="fdots">${ft.slice(-10).map(t=>`<span class="fdot ${t.level}" title="${fmtDay(t.date)} : ${n2(t.v)} m/s"></span>`).join("")}</span></p>` : `<p class="note">Aucun test de forme.</p>`;
    const exos=Object.keys(EXOS).filter(k=>EXOS[k].mvt && perfSets.some(r=>r.player_id===pid && r.exo===k));
    const perf = exos.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Exercice</th><th>1RM estimé</th><th>1 mois</th><th>Meilleures vitesses</th></tr></thead><tbody>${exos.map(k=>{ const pr=perfFor(pid,k);
        return `<tr><td>${esc(EXOS[k].name)}</td><td>${pr.now? "<b>"+Math.round(pr.now.rm)+" kg</b>":"–"}</td><td>${pr.now&&pr.before? (pr.now.rm>=pr.before.rm?"+":"−")+Math.round(Math.abs(pr.now.rm-pr.before.rm))+" kg":"–"}</td><td>${pr.pts.slice(-4).map(q=>`${String(q.load).replace(".",",")} kg : ${n2(q.v)}`).join(" · ")}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="note">Pas encore de séries avec une charge.</p>`;
    const kind=k=> String(k).startsWith("quick-")? "Mesure rapide" : String(k).startsWith("ptest-")? "Test de profil" : "Séance";
    const mine=sets.filter(s=>s.player_id===pid).slice(0,25);
    const rows = mine.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Date</th><th>Type</th><th>Exercice</th><th>Charge</th><th>Rép.</th><th>Meilleure</th><th>Perte</th><th>Amplitude</th></tr></thead><tbody>${mine.map(s=>{ const reps=s.reps||[]; const rom=reps.length? reps.reduce((a,r)=>a+(r.rom||0),0)/reps.length : null;
        return `<tr><td>${fmtDay(s.performed_at)}</td><td>${kind(s.session_key)}</td><td>${esc(exName(s.exo))}</td><td>${s.load_kg!=null? String(s.load_kg).replace(".",",")+" kg":"–"}</td><td>${reps.length}</td><td>${n2(s.best)}</td><td>${s.loss!=null? Math.round(s.loss)+" %":"–"}</td><td>${rom!=null? Math.round(rom*100)+" cm":"–"}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="note">Aucune série reçue sur la période.</p>`;
    const JN={cmj:"CMJ", sj:"Squat jump"}, mj=jumps.filter(s=>s.player_id===pid);
    const jbest=Object.keys(JN).map(k=>{ const l=mj.filter(s=>s.exo===k); return l.length? `${JN[k]} : <b>${Math.max(...l.map(s=>+s.best)).toFixed(1).replace(".",",")} cm</b> (record période)` : ""; }).filter(Boolean).join(" · ");
    const jrows = mj.length ? `<p class="m">${jbest}</p><div class="tblwrap"><table class="tbl"><thead><tr><th>Date</th><th>Test</th><th>Hauteur</th><th>Temps de vol</th><th>Cadence</th></tr></thead><tbody>${mj.slice(0,15).map(s=>{ const r=(s.reps||[])[0]||{};
        return `<tr><td>${fmtDay(s.performed_at)}</td><td>${JN[s.exo]||esc(s.exo)}</td><td><b>${(+s.best).toFixed(1).replace(".",",")} cm</b></td><td>${r.tf? Math.round(r.tf*1000)+" ms":"–"}</td><td>${r.fps? Math.round(r.fps)+" i/s":"–"}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="note">Aucun saut reçu sur la période.</p>`;
    el.innerHTML=`<h3 style="margin:0">${esc(p.name||"Sans nom")}</h3>
      <div class="lbl">Forme du jour</div>${forme}
      <div class="lbl">Performances (1RM estimés)</div>${perf}
      <div class="lbl">Tests de saut</div>${jrows}
      <div class="lbl">Dernières séries</div>${rows}`;
  }

  async function load(){
    const {data:{session}}=await sb.auth.getSession(); user=session?.user||null;
    if(!user){ loginView(); return; }
    const {data:p}=await sb.from("profiles").select("*").eq("id",user.id).maybeSingle(); profile=p;
    if(profile?.role!=="coach"){ main.innerHTML=`<p class="note">Ce compte n'est pas un compte coach. Crée ton équipe depuis l'app (Mon compte › Je suis le coach).</p><a class="btn" href="./">Retour à l'app</a>`; return; }
    const {data:t}=await sb.from("teams").select("*").eq("coach_id",user.id).maybeSingle(); team=t;
    await loadData(); render();
  }
  sb.auth.onAuthStateChange(ev=>{ if(ev==="SIGNED_IN"||ev==="SIGNED_OUT") load(); });
  load();
})();
