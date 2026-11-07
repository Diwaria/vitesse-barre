"use strict";
/* Tests de saut (CMJ, squat jump) : détection du corps image par image (MediaPipe, 33 points),
   décollage et réception repérés sur la pointe des pieds, hauteur par le temps de vol h = g·t²/8. */
(function(){
  const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
  const MODEL = "models/pose_landmarker_full.task";
  const G = 9.81;
  // segments du squelette (indices MediaPipe)
  const BONES = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[27,31],[28,30],[30,32],[28,32],[0,11],[0,12]];
  const JNAME = {cmj:"CMJ", sj:"Squat jump"};
  let lmP=null;
  function landmarker(){
    return lmP ||= (async()=>{
      const vision = await import(MP+"/vision_bundle.mjs");
      const fs = await vision.FilesetResolver.forVisionTasks(MP+"/wasm");
      const mk = delegate => vision.PoseLandmarker.createFromOptions(fs, {baseOptions:{modelAssetPath:MODEL, delegate}, runningMode:"VIDEO", numPoses:1, minPoseDetectionConfidence:0.5, minTrackingConfidence:0.5});
      try{ return await mk("GPU"); }catch(e){ return await mk("CPU"); }
    })().catch(e=>{ lmP=null; throw e; });
  }

  const J = { video:null, url:null, frames:[], w:0, h:0, fpsDet:0, to:-1, ld:-1, cur:0, type:"cmj", busy:false, file:null };
  S.jumps ||= [];
  const jcv=$("jcv"), jctx=jcv.getContext("2d");

  function setMsg(t, bad){ const m=$("jMsg"); m.textContent=t||""; m.hidden=!t; m.className= bad? "warnbox" : "note"; }

  async function openVideo(file){
    if(J.url) URL.revokeObjectURL(J.url);
    J.video?.remove();
    const v=document.createElement("video"); v.muted=true; v.playsInline=true; v.setAttribute("playsinline",""); v.preload="auto";
    J.url=URL.createObjectURL(file); v.src=J.url; v.style.display="none"; document.body.appendChild(v); J.video=v;
    await new Promise((res,rej)=>{ let ok=false; const d=()=>{ if(!ok){ ok=true; res(); } }; v.onloadedmetadata=d; v.onloadeddata=d; v.onerror=()=>rej(new Error("format")); setTimeout(()=>rej(new Error("délai")),30000); v.load(); });
    if(v.readyState<2){ try{ await v.play(); }catch(e){} await new Promise(r=>setTimeout(r,200)); v.pause(); }
    const k=640/Math.max(v.videoWidth, v.videoHeight); J.w=Math.round(v.videoWidth*k); J.h=Math.round(v.videoHeight*k);
    jcv.width=J.w; jcv.height=J.h;
  }

  // image par image : décodage complet (WebCodecs), sinon lecture par sauts de 1/30 s
  async function collect(lm){
    const frames=[]; let lastTs=-1;
    const onImg=(img,t)=>{
      let ts=Math.round(t*1000); if(ts<=lastTs) ts=lastTs+1; lastTs=ts;
      const r=lm.detectForVideo(img, ts); const p=r.landmarks?.[0];
      let a=null; if(p){ a=new Float32Array(99); p.forEach((q,i)=>{ a[i*3]=q.x; a[i*3+1]=q.y; a[i*3+2]=q.visibility??1; }); }
      frames.push({t, p:a});
      if(frames.length%6===0){ jctx.putImageData(img,0,0); drawSkel(a); $("jProg").value=Math.min(1, t/(J.video.duration||1)); }
    };
    try{
      await decodeFile(J.file, 0, J.w, J.h, onImg, ()=>!J.busy);
    }catch(e){
      console.warn("décodage image par image impossible, lecture par sauts :", e);
      frames.length=0; lastTs=-1;
      const v=J.video, dt=1/30;
      for(let t=0; t<(v.duration||0) && J.busy; t+=dt){
        v.currentTime=t; await new Promise(r=>{ v.onseeked=r; setTimeout(r,800); });
        onImg(grabFrom(v,J.w,J.h), t); await new Promise(r=>setTimeout(r,0));
      }
    }
    return frames;
  }

  // décollage / réception : la pointe de pied la plus basse quitte puis retrouve le niveau du sol
  function detect(frames){
    const n=frames.length, fy=new Array(n).fill(NaN); let legs=[];
    for(let i=0;i<n;i++){ const a=frames[i].p; if(!a) continue;
      const toes=[31,32].filter(k=>a[k*3+2]>0.3).map(k=>a[k*3+1]);
      const heels=[29,30].filter(k=>a[k*3+2]>0.3).map(k=>a[k*3+1]);
      const pts=toes.length? toes : heels; if(pts.length) fy[i]=Math.max(...pts);
      const l=[[23,27],[24,28]].map(([h,k])=>Math.hypot(a[h*3]-a[k*3], (a[h*3+1]-a[k*3+1])*J.h/J.w)).filter(isFinite); if(l.length) legs.push(Math.max(...l)); }
    // trous comblés
    for(let i=0;i<n;i++) if(!isFinite(fy[i])){ let j=i; while(j<n && !isFinite(fy[j])) j++; const a=i>0? fy[i-1]:fy[j], b=j<n? fy[j]:a; for(let k=i;k<j;k++) fy[k]= isFinite(a)&&isFinite(b)? a+(b-a)*(k-i+1)/(j-i+1) : (isFinite(a)?a:b); i=j; }
    if(!fy.some(isFinite)) return null;
    const sorted=fy.filter(isFinite).slice().sort((p,q)=>p-q), ground=sorted[Math.floor(sorted.length*0.6)];
    legs.sort((p,q)=>p-q); const L=legs.length? legs[legs.length>>1] : 0.25;
    const thr=0.05*L, edge=0.015*L;
    let best=null;
    for(let i=0;i<n;i++){ if(!(fy[i]<ground-thr)) continue; let j=i; while(j+1<n && fy[j+1]<ground-thr) j++; if(!best || j-i>best[1]-best[0]) best=[i,j]; i=j; }
    if(!best) return {fy, ground, L, to:-1, ld:-1};
    let to=best[0]; while(to>0 && fy[to-1]<ground-edge) to--;
    let ld=best[1]+1; while(ld<n && fy[ld]<ground-edge) ld++;
    ld=Math.min(ld,n-1);
    // affinage : parabole sur la trajectoire en l'air, coupée avec le niveau du sol juste avant / juste après
    try{
      const med=arr=>{ const q=arr.filter(isFinite).sort((x,y)=>x-y); return q.length? q[q.length>>1] : NaN; };
      const span=best[1]-best[0]+1, gap=Math.max(3, Math.round(span*0.15));
      const g0=med(fy.slice(Math.max(0,to-gap*3), Math.max(0,to-1))), g1=med(fy.slice(ld+1, ld+gap*3));
      if(span>=6 && isFinite(g0) && isFinite(g1)){
        let S0=0,S1=0,S2=0,S3=0,S4=0,Y0=0,Y1=0,Y2=0;
        for(let i=best[0];i<=best[1];i++){ const x=i-best[0], y=fy[i]; S0++; S1+=x; S2+=x*x; S3+=x*x*x; S4+=x*x*x*x; Y0+=y; Y1+=x*y; Y2+=x*x*y; }
        const M=[[S4,S3,S2,Y2],[S3,S2,S1,Y1],[S2,S1,S0,Y0]];
        for(let c=0;c<3;c++){ for(let r=c+1;r<3;r++){ const f=M[r][c]/M[c][c]; for(let k=c;k<4;k++) M[r][k]-=f*M[c][k]; } }
        const C=M[2][3]/M[2][2], B=(M[1][3]-M[1][2]*C)/M[1][1], A=(M[0][3]-M[0][2]*C-M[0][1]*B)/M[0][0];
        const root=(g,sg)=>{ const d=B*B-4*A*(C-g); return d>=0? (-B+sg*Math.sqrt(d))/(2*A) : NaN; };
        const r0=best[0]+root(g0,-1), r1=best[0]+root(g1,1), tol=Math.max(2, Math.round(span*0.04));
        if(A>0 && isFinite(r0) && isFinite(r1)){
          const t2=Math.ceil(r0), l2=Math.ceil(r1);
          if(Math.abs(t2-to)<=tol) to=t2;
          if(Math.abs(l2-ld)<=tol) ld=Math.min(l2,n-1);
        }
      }
    }catch(e){}
    return {fy, ground, L, to, ld};
  }

  function drawSkel(a){
    if(!a) return; const W=jcv.width, H=jcv.height, lw=Math.max(2,W/220);
    jctx.lineWidth=lw; jctx.strokeStyle="rgba(53,224,138,.9)";
    for(const [p,q] of BONES){ if(a[p*3+2]<0.3||a[q*3+2]<0.3) continue; jctx.beginPath(); jctx.moveTo(a[p*3]*W,a[p*3+1]*H); jctx.lineTo(a[q*3]*W,a[q*3+1]*H); jctx.stroke(); }
    for(let k=0;k<33;k++){ if(k>0&&k<11) continue; if(a[k*3+2]<0.3) continue; jctx.fillStyle= (k===31||k===32)? "#FF6B35" : "#F5F7FA"; jctx.beginPath(); jctx.arc(a[k*3]*W,a[k*3+1]*H,lw*1.4,0,7); jctx.fill(); }
  }
  function captureFps(){
    const sel=$("jFps").value;
    if(sel!=="auto") return +sel;
    return J.autoFps || J.fpsDet;
  }
  function compute(){
    if(J.to<0 || J.ld<=J.to) return null;
    const fr=J.ld-J.to, fps=captureFps(), tf=fr/fps;
    return {fr, fps, tf, h:G*tf*tf/8};
  }
  async function show(i){
    const f=J.frames[i]; if(!f) return; J.cur=i;
    $("jScrub").value=i;
    const v=J.video; v.currentTime=Math.min(Math.max(0,f.t+0.0005), Math.max(0,(v.duration||0)-0.001));
    await new Promise(r=>{ v.onseeked=r; setTimeout(r,600); });
    if(J.cur!==i) return;
    jctx.clearRect(0,0,jcv.width,jcv.height); jctx.drawImage(v,0,0,jcv.width,jcv.height); drawSkel(f.p);
    const tag = i===J.to? " · décollage" : i===J.ld? " · réception" : (J.to>=0 && i>J.to && i<J.ld? " · en l'air" : "");
    $("jFrame").textContent=`Image ${i+1} / ${J.frames.length}${tag}`;
  }
  function renderRes(){
    const r=compute(), box=$("jRes");
    if(!r){ box.innerHTML=`<p class="warnbox">Décollage ou réception non trouvés. Placez-vous sur l'image du décollage puis sur celle de la réception avec les boutons ci-dessous.</p>`; $("jSave").hidden=true; return; }
    const slow = $("jFps").value==="auto" && J.autoFps && J.autoFps!==J.fpsDet;
    box.innerHTML=`<div class="sum" style="grid-template-columns:repeat(2,1fr)">
      <div class="stat"><b>${(r.h*100).toFixed(1).replace(".",",")} cm</b><span>Hauteur de saut</span></div>
      <div class="stat"><b>${Math.round(r.tf*1000)} ms</b><span>Temps de vol</span></div>
      <div class="stat"><b>${r.fr}</b><span>Images en l'air</span></div>
      <div class="stat"><b>${Math.round(r.fps)} i/s</b><span>Cadence de tournage${slow?" (ralenti détecté)":""}</span></div></div>
      ${r.fps<60? `<p class="note">Vidéo à ${Math.round(r.fps)} images/s : précision d'environ ±${Math.round(G*r.tf/4/r.fps*100*10)/10} cm. Filmez en ralenti pour plus de précision.</p>`:""}`;
    $("jSave").hidden=false;
  }

  async function analyze(file){
    if(!file) return;
    J.busy=false; await new Promise(r=>setTimeout(r,30));
    J.file=file; J.busy=true; J.frames=[]; J.to=J.ld=-1;
    $("jWork").hidden=false; $("jRes").innerHTML=""; $("jSave").hidden=true; $("jTools").hidden=true; $("jProg").hidden=false; $("jProg").value=0;
    $("jWork").scrollIntoView({behavior:"smooth",block:"start"});
    try{
      setMsg("Chargement de la vidéo…"); await openVideo(file);
      setMsg("Chargement de l'intelligence artificielle (première fois : quelques secondes)…");
      const lm=await landmarker();
      setMsg("Analyse du corps image par image…"); holdWake?.();
      const frames=await collect(lm); releaseWake?.();
      if(!J.busy) return;
      J.frames=frames;
      if(frames.length<10){ setMsg("Vidéo trop courte ou illisible.", true); return; }
      const ts=frames.map(f=>f.t); J.fpsDet=(frames.length-1)/Math.max(1e-3, ts[ts.length-1]-ts[0]);
      if(!frames.some(f=>f.p)){ setMsg("Aucun corps détecté. Filmez de profil ou de face, le corps entier dans l'image, pieds compris.", true); return; }
      const d=detect(frames); J.to=d?.to??-1; J.ld=d?.ld??-1;
      // ralenti étiré (iPhone) : temps de vol impossible en temps réel → on suppose 240 ou 120 i/s
      J.autoFps=J.fpsDet;
      if(J.to>=0 && J.fpsDet<90){ const F=J.ld-J.to; if(F/J.fpsDet>0.9) J.autoFps = F/240>=0.25 ? 240 : 120; }
      $("jFpsAuto").textContent=`Auto (${Math.round(J.autoFps)} i/s${J.autoFps!==J.fpsDet?", ralenti":""})`;
      $("jScrub").max=frames.length-1; $("jTools").hidden=false; $("jProg").hidden=true;
      setMsg(J.to>=0? "Vérifiez le décollage et la réception (boutons « Aller au… »), et ajustez si besoin." : "Décollage non trouvé automatiquement : placez-le à la main.", J.to<0);
      renderRes(); await show(J.to>=0? J.to : 0);
      if(J.to>=0){ const r=compute(); if(r) say(`Hauteur de saut : ${(r.h*100).toFixed(1).replace(".", " virgule ")} centimètres.`, true); }
    }catch(e){ console.warn(e); setMsg("Analyse impossible : "+(e.message||e)+". Vérifiez la connexion internet (le modèle se télécharge la première fois).", true); reportErr?.(e); }
    finally{ J.busy=false; $("jProg").hidden=true; }
  }

  function renderJumps(){
    const box=$("jList"); box.textContent="";
    const list=S.jumps||[];
    $("jHistWrap").hidden=!list.length;
    const best={}; list.forEach(j=>{ if(!best[j.type]||j.h>best[j.type]) best[j.type]=j.h; });
    $("jBest").textContent=Object.entries(best).map(([k,h])=>`Record ${JNAME[k]||k} : ${(h*100).toFixed(1).replace(".",",")} cm`).join(" · ");
    list.slice(0,40).forEach(j=>{
      const r=document.createElement("div"); r.className="hrow"; r.style.cursor="default";
      const d=new Date(j.date);
      r.innerHTML=`<span><b>${JNAME[j.type]||j.type}</b><br><span class="sub">${d.toLocaleDateString("fr-FR",{weekday:"short",day:"numeric",month:"short"})} · ${d.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"})} · ${Math.round(j.fps)} i/s</span></span><span style="text-align:right"><b>${(j.h*100).toFixed(1).replace(".",",")} cm</b><br><span class="sub">vol ${Math.round(j.tf*1000)} ms</span></span>`;
      const del=document.createElement("button"); del.type="button"; del.className="linkbtn"; del.style.gridColumn="1/-1"; del.textContent="Supprimer";
      del.onclick=()=>{ if(!del.dataset.arm){ del.dataset.arm=1; del.textContent="Toucher encore pour confirmer"; return; } S.jumps=S.jumps.filter(x=>x.id!==j.id); save(); renderJumps(); };
      r.appendChild(del); box.appendChild(r);
    });
  }

  // boutons
  document.querySelectorAll("#jType button").forEach(b=>b.onclick=()=>{ J.type=b.dataset.t; document.querySelectorAll("#jType button").forEach(x=>x.setAttribute("aria-pressed", String(x===b))); });
  $("jCam").addEventListener("change", e=>{ const f=e.target.files[0]; e.target.value=""; analyze(f); });
  $("jLib").addEventListener("change", e=>{ const f=e.target.files[0]; e.target.value=""; analyze(f); });
  $("jScrub").oninput=e=>show(+e.target.value);
  $("jPrev").onclick=()=>show(Math.max(0,J.cur-1));
  $("jNext").onclick=()=>show(Math.min(J.frames.length-1,J.cur+1));
  $("jGoTo").onclick=()=>{ if(J.to>=0) show(J.to); };
  $("jGoLd").onclick=()=>{ if(J.ld>=0) show(J.ld); };
  $("jSetTo").onclick=()=>{ J.to=J.cur; if(J.ld<=J.to) J.ld=-1; renderRes(); show(J.cur); };
  $("jSetLd").onclick=()=>{ J.ld=J.cur; renderRes(); show(J.cur); };
  $("jFps").onchange=()=>renderRes();
  $("jSave").onclick=()=>{
    const r=compute(); if(!r) return;
    const j={id:"j"+Date.now(), date:Date.now(), type:J.type, h:+r.h.toFixed(4), tf:+r.tf.toFixed(4), fps:r.fps, fr:r.fr};
    S.jumps.unshift(j); S.jumps=S.jumps.slice(0,300); save(); renderJumps();
    window.Cloud?.onJump?.(j);
    $("jSave").hidden=true; say("Saut enregistré.", true);
  };
  window.jumpEnter=()=>{ renderJumps(); };
  window.jumpLeave=()=>{ J.busy=false; };
  window.__jump=J;
  renderJumps();
})();
