"use strict";
/* Compte joueur / coach (Supabase) : connexion, équipe, séances programmées, envoi des séries et des vidéos */
(function(){
  const cfg = window.VB_CONFIG || {};
  const card = document.getElementById("cloudCard");
  if(!cfg.url || !cfg.key){ return; }
  if(!window.supabase){ if(card){ card.hidden=false; card.innerHTML='<h2>Mon compte</h2><p class="note">Connexion au serveur impossible pour le moment. Vérifie ta connexion internet puis recharge la page.</p>'; } return; }
  const sb = window.supabase.createClient(cfg.url, cfg.key);
  window.SB = sb;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const EX = (typeof EXOS!=="undefined")? EXOS : {};
  let user=null, profile=null, team=null;

  /* ---------- Vidéos gardées sur le téléphone (IndexedDB) ---------- */
  function idb(){ return new Promise((res,rej)=>{ const r=indexedDB.open("vbt-videos",1); r.onupgradeneeded=()=>r.result.createObjectStore("v"); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
  async function vPut(id, blob){ try{ const db=await idb(); await new Promise((res,rej)=>{ const t=db.transaction("v","readwrite"); t.objectStore("v").put({blob, t:Date.now()}, id); t.oncomplete=res; t.onerror=()=>rej(t.error); }); await vPrune(); }catch(e){} }
  async function vGet(id){ try{ const db=await idb(); return await new Promise(res=>{ const r=db.transaction("v").objectStore("v").get(id); r.onsuccess=()=>res(r.result?.blob||null); r.onerror=()=>res(null); }); }catch(e){ return null; } }
  async function vDel(id){ try{ const db=await idb(); db.transaction("v","readwrite").objectStore("v").delete(id); }catch(e){} }
  async function vPrune(){ // garde les 40 dernières vidéos
    try{ const db=await idb(); const all=await new Promise(res=>{ const out=[]; const c=db.transaction("v").objectStore("v").openCursor(); c.onsuccess=()=>{ const k=c.result; if(k){ out.push([k.key,k.value.t]); k.continue(); } else res(out); }; c.onerror=()=>res(out); });
      all.sort((a,b)=>b[1]-a[1]); for(const [k] of all.slice(40)) await vDel(k); }catch(e){}
  }

  /* ---------- Envoi d'une série ---------- */
  const QKEY="vbt.queue";
  const qGet=()=>{ try{ return JSON.parse(localStorage.getItem(QKEY)||"[]"); }catch(e){ return []; } };
  const qSet=q=>{ try{ localStorage.setItem(QKEY, JSON.stringify(q)); }catch(e){} };
  async function flushQueue(){
    if(!user || !profile?.team_id) return;
    const q=qGet(); if(!q.length) return;
    const left=[];
    for(const row of q){ const {error}=await sb.from("sets").upsert(row); if(error) left.push(row); }
    qSet(left); renderPlayer();
  }
  window.Cloud = {
    async onSet({res, sess, k, video}){
      const id = (crypto.randomUUID && crypto.randomUUID()) || ("x"+Date.now()+Math.random()).replace(".","");
      const m = S.metric || "mcv";
      const vals = res.reps.map(r=>r[m]);
      const best = vals.length? Math.max(...vals) : null, last = vals.length? vals[vals.length-1] : null;
      const loss = vals.length ? lossAt(vals, vals.length-1) : null;
      const blob = await video; if(blob) await vPut(id, blob);
      if(!user || !profile?.team_id) return;
      const row = { id, player_id:user.id, team_id:profile.team_id, planned_id: sess.plan?.id || null, session_key: sess.key || ("s"+sess.start),
        exo: sess.exo, load_kg: sess.load? parseFloat(String(sess.load).replace(",", ".")) || null : null, set_index:k, metric:m,
        vloss_target: sess.vloss? parseFloat(sess.vloss) || null : null,
        reps: res.reps.map(r=>({mcv:+r.mcv.toFixed(3),mpv:+r.mpv.toFixed(3),peak:+r.peak.toFixed(3),rom:+r.rom.toFixed(3),dur:+r.dur.toFixed(3)})),
        best, last, loss: loss!=null? +loss.toFixed(1) : null, performed_at: new Date(res.date).toISOString() };
      const q=qGet(); q.push(row); qSet(q);
      await flushQueue();
    }
  };

  async function uploadVideo(setRow){
    const blob = await vGet(setRow.id);
    if(!blob) return "absente";
    const ext = (blob.type||"").includes("webm") ? "webm" : "mp4";
    const path = `${setRow.team_id}/${setRow.player_id}/${setRow.id}.${ext}`;
    const up = await sb.storage.from("videos").upload(path, blob, {contentType: blob.type||"video/mp4", upsert:true});
    if(up.error) return "erreur";
    const {error} = await sb.from("sets").update({video_path:path}).eq("id", setRow.id);
    return error? "erreur" : "ok";
  }
  // vidéos demandées par le coach : envoyées automatiquement à l'ouverture
  async function sendRequested(){
    const {data} = await sb.from("sets").select("id,team_id,player_id").eq("player_id", user.id).eq("video_requested", true).is("video_path", null).limit(20);
    for(const r of data||[]) await uploadVideo(r);
  }

  /* ---------- Écrans ---------- */
  function show(html){ card.hidden=false; card.innerHTML=html; }
  function loginView(msg){
    show(`<h2 id="t-cloud">Mon compte</h2>
      <p class="note">Connecte-toi pour recevoir les séances de ton coach et lui envoyer tes séries.</p>
      <div class="grid2">
        <label class="field" id="fName" hidden><span class="lbl">Prénom et nom</span><input id="cName" autocomplete="name"></label>
        <label class="field"><span class="lbl">E-mail</span><input id="cMail" type="email" autocomplete="email" inputmode="email"></label>
        <label class="field"><span class="lbl">Mot de passe</span><input id="cPass" type="password" autocomplete="current-password"></label>
      </div>
      <div class="row"><button type="button" class="primary" id="cLogin">Se connecter</button><button type="button" id="cSignup">Créer un compte</button></div>
      <p class="note" id="cMsg">${esc(msg||"")}</p>`);
    let signup=false;
    $("cSignup").onclick=async()=>{
      if(!signup){ signup=true; $("fName").hidden=false; $("cSignup").classList.add("primary"); $("cLogin").classList.remove("primary"); $("cMsg").textContent="Renseigne ton nom, ton e-mail et un mot de passe (6 caractères minimum), puis appuie à nouveau sur Créer un compte."; return; }
      const name=$("cName").value.trim(), email=$("cMail").value.trim(), password=$("cPass").value;
      if(!name||!email||password.length<6){ $("cMsg").textContent="Il manque le nom, l'e-mail ou un mot de passe d'au moins 6 caractères."; return; }
      const {data,error}=await sb.auth.signUp({email,password,options:{data:{name}, emailRedirectTo: location.href.split("#")[0]}});
      if(error){ $("cMsg").textContent="Inscription impossible : "+error.message; return; }
      if(!data.session){ $("cMsg").textContent="Compte créé. Ouvre l'e-mail de confirmation reçu, puis reviens te connecter ici."; return; }
    };
    $("cLogin").onclick=async()=>{
      const {error}=await sb.auth.signInWithPassword({email:$("cMail").value.trim(), password:$("cPass").value});
      if(error) $("cMsg").textContent = /confirm/i.test(error.message) ? "Confirme d'abord ton adresse avec l'e-mail reçu." : "E-mail ou mot de passe incorrect.";
    };
  }
  function chooseRoleView(){
    show(`<h2 id="t-cloud">Bienvenue ${esc(profile?.name||"")}</h2>
      <p class="note">Rejoins l'équipe de ton coach avec le code qu'il t'a donné.</p>
      <div class="row"><label class="field" style="flex:1 1 140px"><span class="lbl">Code d'équipe</span><input id="cCode" autocapitalize="characters" placeholder="ex. 7F3A9C"></label>
      <button type="button" class="primary" id="cJoin" style="flex:0 0 auto;align-self:end">Rejoindre</button></div>
      <details><summary>Je suis le coach</summary>
        <div class="row" style="margin-top:8px"><label class="field" style="flex:1 1 140px"><span class="lbl">Nom de l'équipe</span><input id="cTeam" placeholder="ex. Seniors A"></label>
        <button type="button" id="cCreate" style="flex:0 0 auto;align-self:end">Créer l'équipe</button></div>
      </details>
      <p class="note" id="cMsg"></p>
      <button type="button" id="cOut">Se déconnecter</button>`);
    $("cJoin").onclick=async()=>{ const {data,error}=await sb.rpc("join_team",{team_code:$("cCode").value}); if(error){ $("cMsg").textContent="Code inconnu. Vérifie-le auprès de ton coach."; return; } await load(); };
    $("cCreate").onclick=async()=>{ const n=$("cTeam").value.trim(); if(!n){ $("cMsg").textContent="Donne un nom à l'équipe."; return; } const {error}=await sb.rpc("create_team",{team_name:n}); if(error){ $("cMsg").textContent="Création impossible : "+error.message; return; } location.href="coach.html"; };
    $("cOut").onclick=()=>sb.auth.signOut();
  }
  let planned=[], mySets=[];
  async function renderPlayer(){
    if(!profile || profile.role!=="player" || !team) return;
    const pend=qGet().length;
    const today=new Date(); today.setHours(0,0,0,0);
    const doneKeys=new Set(mySets.map(s=>s.planned_id).filter(Boolean));
    const fmt=d=>new Date(d+"T12:00").toLocaleDateString("fr-FR",{weekday:"short",day:"numeric",month:"short"});
    const plans=planned.map(p=>{
      const ex=(p.exercises||[]).map(e=>`${esc(EX[e.exo]?.name||e.exo)} ${e.sets}×${e.load? " "+esc(e.load)+" kg":""}`).join(" · ");
      const done=doneKeys.has(p.id);
      return `<div class="setrow${done?"":" cur"}"><span class="k">${fmt(p.day)}</span><span class="m"><b>${esc(p.title||"Séance")}</b><br>${ex}</span>
        <button type="button" class="${done?"":"primary"}" data-plan="${p.id}">${done?"Refaire":"Commencer"}</button></div>`; }).join("") || `<p class="note">Aucune séance programmée pour l'instant.</p>`;
    const vids=mySets.slice(0,8).map(s=>{
      const st = s.video_path? "Vidéo envoyée" : (s.video_requested? "Vidéo demandée" : "");
      return `<div class="setrow"><span class="k">S${s.set_index}</span><span class="m">${esc(EX[s.exo]?.name||s.exo)} · ${new Date(s.performed_at).toLocaleDateString("fr-FR",{day:"numeric",month:"short"})} · meilleure <b>${s.best!=null?(+s.best).toFixed(2).replace(".",","):"–"}</b></span>
        ${s.video_path? `<span class="sub">${st}</span>` : `<button type="button" data-vid="${s.id}">${s.video_requested?"Envoyer (demandée)":"Envoyer la vidéo"}</button>`}</div>`; }).join("");
    show(`<div class="row" style="justify-content:space-between;align-items:baseline"><h2 id="t-cloud" style="flex:0 1 auto">${esc(team.name)}</h2><span class="badge" style="flex:0 0 auto">${esc(profile.name||user.email)}</span></div>
      <div class="lbl">Séances de ton coach</div><div class="sets">${plans}</div>
      ${pend? `<p class="warnbox">${pend} série(s) en attente d'envoi (pas de réseau). Elles partiront automatiquement.</p>`:""}
      ${vids? `<details><summary>Mes dernières séries envoyées</summary><div class="sets" style="margin-top:8px">${vids}</div></details>`:""}
      <p class="note" id="cMsg"></p>
      <button type="button" id="cOut">Se déconnecter</button>`);
    card.querySelectorAll("[data-plan]").forEach(b=>b.onclick=()=>{ const p=planned.find(x=>x.id===b.dataset.plan); if(p) window.startPlan({id:p.id, title:p.title, exercises:p.exercises, key:"p"+p.id.slice(0,8)+"-"+Date.now()}); });
    card.querySelectorAll("[data-vid]").forEach(b=>b.onclick=async()=>{ b.disabled=true; b.textContent="Envoi…"; const s=mySets.find(x=>x.id===b.dataset.vid); const r=await uploadVideo(s); if(r==="absente"){ b.textContent="Vidéo plus sur ce téléphone"; return; } if(r!=="ok"){ b.disabled=false; b.textContent="Réessayer"; return; } await loadSets(); renderPlayer(); });
    $("cOut").onclick=()=>sb.auth.signOut();
  }
  async function loadSets(){
    const {data}=await sb.from("sets").select("id,team_id,player_id,planned_id,exo,set_index,best,performed_at,video_path,video_requested").eq("player_id",user.id).order("performed_at",{ascending:false}).limit(60);
    mySets=data||[];
  }
  async function load(){
    const {data:{session}}=await sb.auth.getSession(); user=session?.user||null;
    if(!user){ loginView(); return; }
    const {data:p}=await sb.from("profiles").select("*").eq("id",user.id).maybeSingle(); profile=p;
    if(!profile?.team_id){ chooseRoleView(); return; }
    const {data:t}=await sb.from("teams").select("*").eq("id",profile.team_id).maybeSingle(); team=t;
    if(profile.role==="coach"){
      show(`<h2 id="t-cloud">${esc(team?.name||"Mon équipe")}</h2><p class="note">Tu es connecté en tant que coach.</p>
        <a class="btn primary big" href="coach.html">Ouvrir l'espace coach</a><button type="button" id="cOut">Se déconnecter</button>`);
      $("cOut").onclick=()=>sb.auth.signOut(); return;
    }
    const since=new Date(Date.now()-7*864e5).toISOString().slice(0,10);
    const {data:pl}=await sb.from("planned_sessions").select("*").gte("day",since).order("day").limit(20); planned=pl||[];
    await loadSets(); await renderPlayer();
    await flushQueue(); sendRequested().then(async()=>{ await loadSets(); renderPlayer(); });
  }
  sb.auth.onAuthStateChange((ev)=>{ if(ev==="SIGNED_IN"||ev==="SIGNED_OUT") load(); });
  window.addEventListener("online", flushQueue);
  load();
})();
