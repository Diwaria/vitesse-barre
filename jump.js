"use strict";
/* Tests de saut (CMJ, squat jump) : détection du corps image par image (MediaPipe, 33 points),
   décollage et réception repérés sur la pointe des pieds, hauteur par le temps de vol h = g·t²/8. */
(function(){
  const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
  const MODEL = "models/pose_landmarker_full.task";
  const G = 9.81;
  const MODE = window.__jumpMode || "VIDEO";
  // segments du squelette (indices MediaPipe)
  const BONES = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[27,31],[28,30],[30,32],[28,32],[0,11],[0,12]];
  const JNAME = {cmj:"CMJ", sj:"Squat jump"};
  let lmP=null;
  function landmarker(){
    return lmP ||= (async()=>{
      const vision = await import(MP+"/vision_bundle.mjs");
      const fs = await vision.FilesetResolver.forVisionTasks(MP+"/wasm");
      const mk = delegate => vision.PoseLandmarker.createFromOptions(fs, {baseOptions:{modelAssetPath:MODEL, delegate}, runningMode:MODE, numPoses:1, minPoseDetectionConfidence:0.5, minTrackingConfidence:0.5});
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
  /* Suivi des pieds par l'image quand l'IA perd le corps (ex. le haut du corps sort du cadre en l'air) :
     on mémorise un petit carré autour de chaque pied sur la dernière image fiable et on le retrouve
     dans l'image suivante (corrélation), surtout verticalement. */
  function grayAt(img, x0, y0, w, h){
    const W=img.width, H=img.height, d=img.data, g=new Float32Array(w*h);
    for(let y=0;y<h;y++){ const yy=Math.min(H-1,Math.max(0,y0+y)); for(let x=0;x<w;x++){ const xx=Math.min(W-1,Math.max(0,x0+x)), k=(yy*W+xx)*4; g[y*w+x]=d[k]*0.3+d[k+1]*0.59+d[k+2]*0.11; } }
    return g;
  }
  function footTracker(){
    const feet=[null,null];   // {tpl, w, h, x, y, toeDy}
    function ncc(win, ww, f, ox, oy){
      let sa=0,sb=0,saa=0,sbb=0,sab=0; const n=f.w*f.h, t=f.tpl;
      for(let y=0;y<f.h;y++){ const r=(oy+y)*ww+ox, q=y*f.w; for(let x=0;x<f.w;x++){ const a=win[r+x], b=t[q+x]; sa+=a; sb+=b; saa+=a*a; sbb+=b*b; sab+=a*b; } }
      const cov=sab-sa*sb/n, va=saa-sa*sa/n, vb=sbb-sb*sb/n; return va>1e-6&&vb>1e-6? cov/Math.sqrt(va*vb) : 0;
    }
    return {
      learn(img, a){   // a = points de l'IA ; le carré couvre la chaussure / chaussette au-dessus de la pointe, sans le sol
        const W=img.width, H=img.height;
        [[29,31,27],[30,32,28]].forEach(([he,to,an],i)=>{
          if(a[he*3+2]<0.5 || a[to*3+2]<0.5 || a[an*3+2]<0.5) return;
          const xs=[he,to,an].map(k=>a[k*3]*W), toeY=Math.max(a[to*3+1],a[he*3+1])*H;
          let x0=Math.min(...xs)-4, x1=Math.max(...xs)+4; if(x1-x0<14){ const c=(x0+x1)/2; x0=c-7; x1=c+7; } if(x1-x0>48){ const c=(x0+x1)/2; x0=c-24; x1=c+24; }
          let y1=toeY-2, y0=Math.min(a[an*3+1]*H-6, y1-10); if(y1-y0>40) y0=y1-40;
          const x=Math.round(x0), y=Math.round(y0), w=Math.round(x1-x0), h=Math.round(y1-y0);
          feet[i]={tpl:grayAt(img,x,y,w,h), w, h, x, y, toeDy:a[to*3+1]*H-y};
        });
      },
      track(img){   // renvoie la position verticale de la pointe de pied (normalisée), ou NaN
        const H=img.height, R=12, V=48, ys=[];
        for(const f of feet){ if(!f) continue;
          const ww=f.w+2*R, wh=f.h+2*V, win=grayAt(img, f.x-R, f.y-V, ww, wh);
          let best=-1, bx=0, by=0;
          for(let oy=0;oy<=2*V;oy++) for(let ox=0;ox<=2*R;ox+=2){ const c=ncc(win,ww,f,ox,oy); if(c>best){ best=c; bx=ox; by=oy; } }
          if(best<0.6) continue;
          f.x+=bx-R; f.y+=by-V;
          if(best>0.85) f.tpl=grayAt(img,f.x,f.y,f.w,f.h);   // le pied change d'aspect en l'air
          ys.push((f.y+f.toeDy)/H);
        }
        return ys.length? ys.reduce((p,q)=>p+q,0)/ys.length : NaN;
      },
      ok(){ return feet.some(Boolean); }
    };
  }

  async function collect(lm){
    const frames=[]; let lastTs=-1, lost=0, off=0, still=0, lastPy=NaN; const ft=footTracker();
    const onImg=(img,t)=>{
      let ts=Math.round(t*1000); if(ts<=lastTs) ts=lastTs+1; lastTs=ts;
      const r= MODE==="IMAGE"? lm.detect(img) : lm.detectForVideo(img, ts); const p=r.landmarks?.[0];
      let a=null; if(p){ a=new Float32Array(99); p.forEach((q,i)=>{ a[i*3]=q.x; a[i*3+1]=q.y; a[i*3+2]=q.visibility??1; }); }
      const good = a && [29,30,31,32].every(k=>a[k*3+2]>0.5) && a[23*3+2]>0.5 && a[24*3+2]>0.5;
      // le suivi par l'image est la référence ; l'IA ne le recale que si les deux sont d'accord
      // (en l'air, quand le haut du corps sort du cadre, l'IA peut placer les pieds n'importe où)
      let ty = ft.ok()? ft.track(img) : NaN;
      if(isFinite(ty)) lost=0; else lost++;
      if(good){ const py=Math.max(a[31*3+1],a[32*3+1]);
        const agree=isFinite(ty) && Math.abs(py-ty)*img.height<6;
        // désaccord qui dure alors que l'IA voit les pieds immobiles (debout) : le suivi s'est accroché ailleurs
        still = Math.abs(py-lastPy)*img.height<2 ? still+1 : 0; lastPy=py; off = agree? 0 : off+1;
        if(!ft.ok() || lost>8 || agree || (off>15 && still>10)){ ft.learn(img,a); off=0; if(!isFinite(ty)) ty=py; } }
      frames.push({t, p:a, ty});
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
  function detect(frames, tight){
    const n=frames.length, fy=new Array(n).fill(NaN); let legs=[];
    // suivi par l'image « figé » (même position plusieurs images) alors que l'IA voit les pieds ailleurs : décroché
    const tyc=frames.map(f=>f.ty), poseY=i=>{ const a=frames[i].p; return a? Math.max(a[31*3+1],a[32*3+1]) : NaN; };
    for(let i=0;i<n;i++){ if(!isFinite(tyc[i])) continue; let j=i; while(j+1<n && isFinite(tyc[j+1]) && Math.abs(tyc[j+1]-tyc[j])*J.h<0.6) j++;
      if(j-i>=4){ let bad=false; for(let k=i;k<=j;k++){ const q=poseY(k); if(isFinite(q) && Math.abs(q-tyc[k])>0.02){ bad=true; break; } } if(bad) for(let k=i;k<=j;k++) tyc[k]=NaN; }
      i=j; }
    for(let i=0;i<n;i++){ const a=frames[i].p; if(!a){ if(isFinite(tyc[i])) fy[i]=tyc[i]; continue; }
      const toes=[31,32].filter(k=>a[k*3+2]>0.3).map(k=>a[k*3+1]);
      const heels=[29,30].filter(k=>a[k*3+2]>0.3).map(k=>a[k*3+1]);
      const pts=toes.length? toes : heels; if(pts.length) fy[i]=Math.max(...pts);
      if(isFinite(tyc[i])) fy[i]=tyc[i];   // pieds suivis par l'image (prioritaire)
      const l=[[23,27],[24,28]].map(([h,k])=>Math.hypot(a[h*3]-a[k*3], (a[h*3+1]-a[k*3+1])*J.h/J.w)).filter(isFinite); if(l.length) legs.push(Math.max(...l)); }
    // petits trous comblés (≤ 6 images) ; les grands restent vides (corps hors champ)
    for(let i=0;i<n;i++) if(!isFinite(fy[i])){ let j=i; while(j<n && !isFinite(fy[j])) j++; if(i>0 && j<n && j-i<=6){ const a=fy[i-1], b=fy[j]; for(let k=i;k<j;k++) fy[k]=a+(b-a)*(k-i+1)/(j-i+1); } i=j; }
    if(!fy.some(isFinite)) return null;
    const sorted=fy.filter(isFinite).slice().sort((p,q)=>p-q), ground=sorted[Math.floor(sorted.length*0.6)];
    // sol local (la personne peut s'approcher / s'éloigner du téléphone entre deux sauts)
    const W=Math.max(60, Math.round(n*0.08)), gl=new Array(n).fill(ground);
    for(let i=0;i<n;i+=5){ const w=fy.slice(Math.max(0,i-W), Math.min(n,i+W)).filter(isFinite).sort((p,q)=>p-q); const g=w.length>20? w[Math.floor(w.length*0.6)] : ground; for(let k=i;k<Math.min(n,i+5);k++) gl[k]=g; }
    legs.sort((p,q)=>p-q); const L=legs.length? legs[legs.length>>1] : 0.25;
    const thr=0.05*L, edge=0.015*L;
    // trou en plein vol (corps mal vu au sommet) : pieds en l'air des deux côtés → on relie
    for(let i=1;i<n;i++) if(!isFinite(fy[i]) && isFinite(fy[i-1])){ let j=i; while(j<n && !isFinite(fy[j])) j++;
      if(j<n && j-i<=60 && fy[i-1]<gl[i-1]-thr && fy[j]<gl[j]-thr){ const a=fy[i-1], b=fy[j]; for(let k=i;k<j;k++) fy[k]=a+(b-a)*(k-i+1)/(j-i+1); } i=j; }
    const med=arr=>{ const q=arr.filter(isFinite).sort((x,y)=>x-y); return q.length? q[q.length>>1] : NaN; };
    // toutes les phases en l'air (plusieurs sauts possibles dans la vidéo)
    const runs=[];
    for(let i=0;i<n;i++){ if(!(fy[i]<gl[i]-thr)) continue; let j=i; while(j+1<n && fy[j+1]<gl[j+1]-thr) j++; runs.push([i,j]); i=j; }
    const longest=runs.reduce((m,r)=>Math.max(m,r[1]-r[0]+1),0);
    const jumps=[];
    for(const best of runs){
      const span=best[1]-best[0]+1; if(span<Math.max(4, longest*0.4)) continue;   // bruit / petits pas
      // il faut voir les pieds au sol juste avant et juste après
      if(!(best[0]>0 && isFinite(fy[best[0]-1])) || !(best[1]+1<n && isFinite(fy[best[1]+1]))) continue;
      // suivi par l'image : le carré suivi bouge déjà un peu pendant l'appel (cheville), on s'arrête au seuil
      let to=best[0]; if(!tight) while(to>0 && fy[to-1]<gl[to-1]-edge) to--;
      let ld=best[1]+1; if(!tight) while(ld<n && fy[ld]<gl[ld]-edge) ld++;
      ld=Math.min(ld,n-1);
      // affinage : parabole sur la trajectoire en l'air, coupée avec le niveau du sol juste avant / juste après
      try{
        const gap=Math.max(3, Math.round(span*0.15));
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
      let top=Infinity; for(let i=best[0];i<=best[1];i++) if(fy[i]<top) top=fy[i];
      const rise=Math.max(0, gl[best[0]]-top) * (J.h/J.w) / L;   // montée des pieds, en longueurs de jambe
      if(ld>to && !jumps.some(x=>x.to===to||x.ld===ld)) jumps.push({to, ld, rise});
    }
    const maxRise=Math.max(0,...jumps.map(x=>x.rise));
    return {fy, ground, L, jumps: jumps.filter(x=>x.rise>=0.4*maxRise)};
  }

  function drawSkel(a){
    if(!a) return; const W=jcv.width, H=jcv.height, lw=Math.max(2,W/220);
    jctx.lineWidth=lw; jctx.strokeStyle="rgba(53,224,138,.9)";
    for(const [p,q] of BONES){ if(a[p*3+2]<0.3||a[q*3+2]<0.3) continue; jctx.beginPath(); jctx.moveTo(a[p*3]*W,a[p*3+1]*H); jctx.lineTo(a[q*3]*W,a[q*3+1]*H); jctx.stroke(); }
    for(let k=0;k<33;k++){ if(k>0&&k<11) continue; if(a[k*3+2]<0.3) continue; jctx.fillStyle= (k===31||k===32)? "#FF6B35" : "#F5F7FA"; jctx.beginPath(); jctx.arc(a[k*3]*W,a[k*3+1]*H,lw*1.4,0,7); jctx.fill(); }
  }
  // ralenti iPhone ré-encodé en 30 i/s : 120 ou 240 ? On garde la cadence dont la hauteur (temps de vol)
  // colle le mieux à la montée des pieds vue dans l'image (jambe ≈ 0,85 m) ; à défaut, durée de vol plausible.
  function sloFps(x){
    const F=(J.frames[x.ld].t-J.frames[x.to].t)*J.base, h=f=>G*(F/f)*(F/f)/8, hd=(x.rise||0)*0.85;
    if(hd>0.05) return Math.abs(Math.log(h(120)/hd)) <= Math.abs(Math.log(h(240)/hd)) ? 120 : 240;
    return F/120<=0.75 ? 120 : 240;
  }
  /* Deux lectures des pieds : l'IA seule, et le suivi par l'image. Chacune a ses pièges (l'IA déraille quand
     le haut du corps sort du cadre, le suivi peut rester accroché au sol) et les deux raccourcissent alors la
     phase en l'air. L'IA est gardée, sauf quand elle ne voit qu'un morceau du vol. */
  function bestJumps(frames){
    const a=detect(frames.map(f=>({t:f.t, p:f.p, ty:NaN})))?.jumps||[], b=detect(frames)?.jumps||[];
    const over=(x,y)=>Math.min(x.ld,y.ld)-Math.max(x.to,y.to)>0;
    b.forEach(y=>y.src="suivi");
    // l'IA reste la référence (plus précise) ; le suivi ne remplace que des morceaux de vol (IA perdue en l'air)
    const out=a.map(x=>{ const y=b.find(y=>over(x,y)); return y && (y.ld-y.to)>1.5*(x.ld-x.to) ? y : x; });
    for(const y of b) if(!a.some(x=>over(x,y))) out.push(y);
    return [...new Set(out)].sort((x,y)=>x.to-y.to);
  }
  function captureFps(){
    const sel=$("jFps").value;
    if(sel!=="auto") return +sel;
    return J.autoFps || J.fpsDet;
  }
  // temps de vol à partir des horodatages (certains exports ont des images irrégulières ou sautées) ;
  // ralenti lu à vitesse normale : chaque image du fichier (cadence de base, 30 i/s) = 1/fps seconde réelle
  function flight(x, fps){
    const dt=J.frames[x.ld].t-J.frames[x.to].t;
    return fps>1.5*J.fpsDet ? dt*J.base/fps : dt;
  }
  function compute(){
    if(J.to<0 || J.ld<=J.to) return null;
    const fr=J.ld-J.to, fps=captureFps(), tf=flight({to:J.to, ld:J.ld}, fps);
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
    const fps=captureFps(), hOf=x=>{ const t=flight(x,fps); return G*t*t/8; };
    const chips = J.jumps.length>1 ? `<div class="lbl" style="margin-top:4px">${J.jumps.length} sauts trouvés · meilleur ${(Math.max(...J.jumps.map(hOf))*100).toFixed(1).replace(".",",")} cm</div>
      <div class="seg" style="flex-wrap:wrap;margin-bottom:8px">${J.jumps.map((x,i)=>`<button type="button" data-jsel="${i}" aria-pressed="${i===J.sel}">Saut ${i+1} : ${(hOf(x)*100).toFixed(1).replace(".",",")} cm</button>`).join("")}</div>` : "";
    box.innerHTML=chips+`<div class="sum" style="grid-template-columns:repeat(2,1fr)">
      <div class="stat"><b>${(r.h*100).toFixed(1).replace(".",",")} cm</b><span>Hauteur de saut</span></div>
      <div class="stat"><b>${Math.round(r.tf*1000)} ms</b><span>Temps de vol</span></div>
      <div class="stat"><b>${r.fr}</b><span>Images en l'air</span></div>
      <div class="stat"><b>${Math.round(r.fps)} i/s</b><span>Cadence de tournage${slow?" (ralenti détecté)":""}</span></div></div>
      ${slow && J.guess? `<div class="warnbox" style="margin-top:8px">Ralenti exporté par l'iPhone : la cadence réelle n'est plus dans le fichier. L'app a choisi <b>${J.autoPick} i/s</b> d'après la hauteur à laquelle montent les pieds. Si la hauteur vous paraît fausse, changez :
        <div class="seg" style="margin-top:8px">${[120,240].map(f=>`<button type="button" data-slo="${f}" aria-pressed="${J.autoFps===f}">${f} i/s</button>`).join("")}</div>
</div>`:""}
      ${r.fps<60? `<p class="note">Vidéo à ${Math.round(r.fps)} images/s : précision d'environ ±${Math.round(G*r.tf/4/r.fps*100*10)/10} cm. Filmez en ralenti pour plus de précision.</p>`:""}`;
    $("jSave").hidden=false;
    box.querySelectorAll("[data-jsel]").forEach(b=>b.onclick=()=>{ J.sel=+b.dataset.jsel; J.to=J.jumps[J.sel].to; J.ld=J.jumps[J.sel].ld; $("jSave").textContent="Enregistrer le saut"; renderRes(); show(J.to); });
    box.querySelectorAll("[data-slo]").forEach(b=>b.onclick=()=>{ J.autoFps=+b.dataset.slo; $("jFpsAuto").textContent=`Auto (${J.autoFps} i/s, ralenti)`; renderRes(); });
  }

  async function analyze(file){
    if(!file) return;
    J.busy=false; await new Promise(r=>setTimeout(r,30));
    J.file=file; J.busy=true; J.frames=[]; J.to=J.ld=-1; J.jumps=[]; J.sel=-1;
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
      { const d=ts.slice(1).map((t,i)=>t-ts[i]).filter(v=>v>1e-4).sort((p,q)=>p-q); J.base= d.length? 1/d[d.length>>1] : J.fpsDet; }
      if(!frames.some(f=>f.p)){ setMsg("Aucun corps détecté. Filmez de profil ou de face, le corps entier dans l'image, pieds compris.", true); return; }
      J.jumps=bestJumps(frames); J.sel=J.jumps.length? J.jumps.reduce((b,x,i,a)=>x.ld-x.to>a[b].ld-a[b].to? i : b, 0) : -1; J.to=J.sel>=0? J.jumps[J.sel].to : -1; J.ld=J.sel>=0? J.jumps[J.sel].ld : -1;
      // ralenti étiré (iPhone) : temps de vol impossible en temps réel → on suppose 240 ou 120 i/s
      J.autoFps=J.fpsDet; J.guess=false;
      if(J.to>=0 && J.fpsDet<90){ const dt=J.frames[J.ld].t-J.frames[J.to].t; if(dt>0.9){ J.guess=true; J.autoFps=J.autoPick=sloFps(J.jumps[J.sel]); } }
      $("jFpsAuto").textContent=`Auto (${Math.round(J.autoFps)} i/s${J.autoFps!==J.fpsDet?", ralenti":""})`;
      $("jScrub").max=frames.length-1; $("jTools").hidden=false; $("jProg").hidden=true;
      const cover=frames.filter(f=>f.p).length/frames.length;
      const cadre= cover<0.7? ` Le corps n'est reconnu que sur ${Math.round(cover*100)} % des images : cadrez le corps entier, de la tête aux pieds, téléphone fixe.` : "";
      const viaSuivi=J.jumps.some(x=>x.src==="suivi");
      setMsg((viaSuivi? "Corps mal cadré : décollage et réception estimés par le suivi des pieds, moins précis. Vérifiez-les image par image (boutons ci-dessous). " : "")+(J.to>=0? "Vérifiez le décollage et la réception (boutons « Aller au… »), et ajustez si besoin." : "Décollage non trouvé automatiquement : placez-le à la main.")+cadre, J.to<0 || !!cadre);
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
  const syncSel=()=>{ const x=J.jumps[J.sel]; if(x && J.to>=0 && J.ld>J.to){ x.to=J.to; x.ld=J.ld; } };
  $("jSetTo").onclick=()=>{ J.to=J.cur; if(J.ld<=J.to) J.ld=-1; syncSel(); renderRes(); show(J.cur); };
  $("jSetLd").onclick=()=>{ J.ld=J.cur; syncSel(); renderRes(); show(J.cur); };
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
