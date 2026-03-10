/**
 * Living Soul — SillyTavern Extension
 * v1.0.0
 *
 * Живые эмоции {{char}} в реальном времени.
 * Радар из 8 осей · Тайные мысли · График истории · Триггеры поведения
 */

(() => {
  'use strict';

  const MODULE_KEY  = 'living_soul';
  const SOUL_TAG    = 'LS_SOUL';
  const FAB_POS_KEY = 'ls_fab_v1';
  const FAB_MARGIN  = 8;
  const API_MODEL   = 'claude-sonnet-4-20250514';
  const MAX_HISTORY = 60;

  const EMOTIONS = [
    { id: 'fear',    name: 'Страх',      icon: '😨', color: '#9966ff' },
    { id: 'love',    name: 'Любовь',     icon: '❤️',  color: '#ff4488' },
    { id: 'anger',   name: 'Злость',     icon: '😡', color: '#ff3322' },
    { id: 'trust',   name: 'Доверие',    icon: '🤝', color: '#22cc88' },
    { id: 'disgust', name: 'Отвращение', icon: '🤢', color: '#aacc22' },
    { id: 'joy',     name: 'Радость',    icon: '✨', color: '#ffcc22' },
    { id: 'sadness', name: 'Тоска',      icon: '🌧️', color: '#4499dd' },
    { id: 'desire',  name: 'Желание',    icon: '🔥', color: '#ff7722' },
  ];
  const EMOTION_MAP = Object.fromEntries(EMOTIONS.map(e => [e.id, e]));

  const TRIGGERS = [
    { id: 'fear_spike',   emotion: 'fear',    threshold: 75, dir: 'above', name: '😨 Паника',
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}}: охвачен(а) паникой и страхом. Движения нервные, голос дрожит. {{char}} избегает прямого взгляда, может резко отстраниться. Страх диктует каждое слово в этой сцене.' },
    { id: 'love_deep',    emotion: 'love',    threshold: 82, dir: 'above', name: '❤️ Влюблённость',
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}}: глубоко влюблён(а) в {{user}}. Каждое движение {{user}} замечается. {{char}} с трудом скрывает нежность — она прорывается в голосе, взгляде, случайных прикосновениях.' },
    { id: 'anger_rage',   emotion: 'anger',   threshold: 78, dir: 'above', name: '😡 Ярость',
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}}: на грани взрыва. Злость кипит внутри. Речь стала резкой и обрывистой. {{char}} может сорваться в любой момент.' },
    { id: 'trust_none',   emotion: 'trust',   threshold: 15, dir: 'below', name: '🔒 Недоверие',
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}}: полностью не доверяет {{user}}. Анализирует каждое слово. Отвечает уклончиво, держит дистанцию.' },
    { id: 'desire_hot',   emotion: 'desire',  threshold: 80, dir: 'above', name: '🔥 Влечение',
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}}: сильное физическое влечение к {{user}} мешает сосредоточиться. Взгляд задерживается чуть дольше, голос становится тише и глубже.' },
    { id: 'sadness_abyss',emotion: 'sadness', threshold: 80, dir: 'above', name: '🌧️ Отчаяние',
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}}: погружён(а) в глубокую тоску. Слова даются тяжело. {{char}} может умолкать на полуслове. Внутри — ощущение пустоты.' },
    { id: 'joy_euphoria', emotion: 'joy',     threshold: 88, dir: 'above', name: '✨ Эйфория',
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}}: переполнен(а) радостью. Движения лёгкие, речь быстрее. {{char}} может засмеяться без причины или сделать что-то спонтанное.' },
    { id: 'disgust_rep',  emotion: 'disgust', threshold: 75, dir: 'above', name: '🤢 Отвержение',
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}}: испытывает сильное отвращение. Слова выбираются с едкой точностью. {{char}} хочет прекратить взаимодействие.' },
  ];

  let panelOpen    = false;
  let activeTab    = 'radar';
  let analyzing    = false;
  let lastFabDragTs= 0;
  let activeTriggerIds = new Set();
  let _cachedEmotions  = null;

  function ctx()  { return SillyTavern.getContext(); }
  function vpW()  { return window.visualViewport?.width  || window.innerWidth;  }
  function vpH()  { return window.visualViewport?.height || window.innerHeight; }
  function clamp(v,mn,mx){ return Math.max(mn,Math.min(mx,v)); }
  function escHtml(s){ return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
  function getDominantEmotion(emotions){
    let best=EMOTIONS[0],bestVal=0;
    for(const e of EMOTIONS){ const v=emotions[e.id]||0; if(v>bestVal){bestVal=v;best=e;} }
    return best;
  }

  function getSettings(){
    const c=ctx();
    if(!c.extensionSettings[MODULE_KEY]) c.extensionSettings[MODULE_KEY]={};
    const s=c.extensionSettings[MODULE_KEY];
    if(s.enabled         ===undefined) s.enabled         =true;
    if(s.showFab         ===undefined) s.showFab         =true;
    if(s.apiEnabled      ===undefined) s.apiEnabled      =true;
    if(s.triggersEnabled ===undefined) s.triggersEnabled =true;
    if(s.showThoughtBubble===undefined)s.showThoughtBubble=true;
    if(s.decayEnabled    ===undefined) s.decayEnabled    =true;
    if(s.decayRate       ===undefined) s.decayRate       =3;
    return s;
  }

  function chatKey(){
    const c=ctx();
    const charId=c.characterId??'unknown';
    const chatId=c.getCurrentChatId?.()??'default';
    return `ls_v1__${charId}__${chatId}`;
  }

  function emptyState(){
    return { emotions:{fear:10,love:20,anger:5,trust:55,disgust:5,joy:30,sadness:10,desire:10}, history:[], lastThought:'', lastThoughtEmotion:'', msgCount:0 };
  }

  async function getSoulState(create=false){
    const key=chatKey();
    if(!ctx().chatMetadata[key]){
      if(create){ ctx().chatMetadata[key]=emptyState(); await ctx().saveMetadata(); }
      else return emptyState();
    }
    const s=ctx().chatMetadata[key];
    if(!s.emotions)  s.emotions =emptyState().emotions;
    if(!s.history)   s.history  =[];
    if(!s.lastThought)s.lastThought='';
    if(!s.msgCount)  s.msgCount =0;
    return s;
  }
  async function saveState(){ await ctx().saveMetadata(); }

  function showToast(msg,type='info',duration=3500){
    const el=document.createElement('div');
    el.className=`ls-toast ls-toast-${type}`;
    el.innerHTML=msg;
    document.body.appendChild(el);
    requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add('ls-toast-show')));
    setTimeout(()=>{ el.classList.remove('ls-toast-show'); setTimeout(()=>el.remove(),400); },duration);
  }

  async function analyzeMessage(botMessage,charName,userName,previousEmotions){
    if(!getSettings().apiEnabled) return null;
    const prevStr=EMOTIONS.map(e=>`${e.name}:${previousEmotions[e.id]||0}`).join(',');
    const prompt=`Ты — психологический анализатор RP-персонажа.
Персонаж: ${charName}
Пользователь: ${userName}
Предыдущие эмоции (0-100): ${prevStr}
Последнее сообщение персонажа:
"""
${botMessage.slice(0,1200)}
"""
Проанализируй эмоциональное состояние ${charName} после этого сообщения.
Эмоции меняются постепенно — резкие скачки только при сильных триггерах.
Ответь СТРОГО JSON без markdown:
{"emotions":{"fear":0,"love":0,"anger":0,"trust":0,"disgust":0,"joy":0,"sadness":0,"desire":0},"thought":"<тайная мысль 1-2 предложения на русском>","dominantEmotion":"<id>","shift":"<что изменилось 1 предложение>"}`;
    try{
      const resp=await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({model:API_MODEL,max_tokens:800,messages:[{role:'user',content:prompt}]})
      });
      if(!resp.ok) throw new Error(`API ${resp.status}`);
      const data=await resp.json();
      const raw=data.content?.find(b=>b.type==='text')?.text||'';
      return JSON.parse(raw.replace(/```json|```/g,'').trim());
    }catch(e){ console.error('[LS] API:',e); return null; }
  }

  function applyDecay(emotions){
    if(!getSettings().decayEnabled) return emotions;
    const rate=getSettings().decayRate??3;
    const neutral={fear:5,love:20,anger:5,trust:55,disgust:5,joy:25,sadness:10,desire:10};
    const r={...emotions};
    for(const e of EMOTIONS){
      const cur=r[e.id]||0, neu=neutral[e.id];
      if(cur>neu) r[e.id]=Math.max(neu,cur-rate);
      else if(cur<neu) r[e.id]=Math.min(neu,cur+rate);
    }
    return r;
  }

  function buildSoulPrompt(state){
    const e=state.emotions;
    const dominant=getDominantEmotion(e);
    const high=EMOTIONS.filter(em=>(e[em.id]||0)>=60).sort((a,b)=>(e[b.id]||0)-(e[a.id]||0));
    const lines=['ЭМОЦИОНАЛЬНЫЙ ПРОФИЛЬ {{char}} (скрытое):'];
    if(high.length>0) lines.push(`Сильные эмоции: ${high.map(em=>`${em.name} ${e[em.id]}%`).join(', ')}.`);
    if((e.trust||0)<30) lines.push(`Низкое доверие (${e.trust}%) — {{char}} насторожен(а).`);
    lines.push(`Доминирует: ${dominant.name} (${e[dominant.id]}%). {{char}} ведёт себя соответственно, не называя это прямо.`);
    return lines.join(' ');
  }

  async function updateSoulPrompt(){
    const state=await getSoulState();
    try{ ctx().setExtensionPrompt(SOUL_TAG,buildSoulPrompt(state),0,0,true); }catch(e){ console.error('[LS]',e); }
  }

  function checkTriggers(emotions){
    const s=getSettings();
    if(!s.triggersEnabled) return [];
    const fired=[];
    for(const tr of TRIGGERS){
      const val=emotions[tr.emotion]||0;
      const passes=tr.dir==='above'?val>=tr.threshold:val<=tr.threshold;
      const was=activeTriggerIds.has(tr.id);
      if(passes&&!was){ activeTriggerIds.add(tr.id); fired.push(tr); }
      else if(!passes&&was){ activeTriggerIds.delete(tr.id); }
    }
    return fired;
  }

  async function updateTriggerPrompt(){
    const active=TRIGGERS.filter(tr=>activeTriggerIds.has(tr.id));
    const text=active.map(tr=>tr.prompt).join('\n');
    try{ ctx().setExtensionPrompt('LS_TRIGGER',text,0,0,true); }catch{}
  }

  async function onMessageReceived(){
    if(analyzing) return;
    if(!getSettings().enabled) return;
    analyzing=true;
    try{
      const c=ctx();
      const chat=c.chat;
      if(!chat||chat.length===0) return;
      const lastMsg=[...chat].reverse().find(m=>!m.is_user);
      if(!lastMsg) return;
      const state=await getSoulState(true);
      const charName=c.name2||'Персонаж';
      const userName=c.name1||'Пользователь';
      state.emotions=applyDecay(state.emotions);
      const fabIcon=document.getElementById('ls_fab_icon');
      if(fabIcon) fabIcon.textContent='🔮';
      const result=await analyzeMessage(lastMsg.mes,charName,userName,state.emotions);
      if(result&&result.emotions){
        for(const e of EMOTIONS){
          if(typeof result.emotions[e.id]==='number')
            state.emotions[e.id]=clamp(Math.round(result.emotions[e.id]),0,100);
        }
        if(result.thought){ state.lastThought=result.thought; state.lastThoughtEmotion=result.dominantEmotion||getDominantEmotion(state.emotions).id; }
        state.history.push({ ts:Date.now(), msgIndex:state.msgCount, emotions:{...state.emotions}, thought:result.thought||'', shift:result.shift||'', charMsg:lastMsg.mes.slice(0,120) });
        if(state.history.length>MAX_HISTORY) state.history.shift();
        state.msgCount++;
        const fired=checkTriggers(state.emotions);
        for(const tr of fired) showToast(`${tr.name} активирован!`,'trigger',4500);
        await updateTriggerPrompt();
        if(getSettings().showThoughtBubble&&result.thought) showThoughtBubble(result.thought,result.dominantEmotion);
      } else { state.msgCount++; }
      await saveState();
      await updateSoulPrompt();
      updateFabDisplay(state);
      if(panelOpen) await renderPanelContent();
    }finally{
      analyzing=false;
      const fabIcon=document.getElementById('ls_fab_icon');
      if(fabIcon){ const s=await getSoulState(); fabIcon.textContent=getDominantEmotion(s.emotions).icon; }
    }
  }

  function showThoughtBubble(thought,emotionId){
    document.querySelectorAll('.ls-thought-bubble').forEach(el=>el.remove());
    const ed=EMOTION_MAP[emotionId]||EMOTIONS[0];
    const el=document.createElement('div');
    el.className='ls-thought-bubble';
    el.style.setProperty('--bubble-color',ed.color);
    el.innerHTML=`<div class="ls-bubble-header"><span>${ed.icon}</span><span class="ls-bubble-label">Тайная мысль</span><button class="ls-bubble-close" type="button">✕</button></div><div class="ls-bubble-text">${escHtml(thought)}</div>`;
    document.body.appendChild(el);
    el.querySelector('.ls-bubble-close').addEventListener('click',e=>{
      e.stopPropagation(); el.classList.add('ls-bubble-hide'); setTimeout(()=>el.remove(),400);
    },true);
    requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add('ls-bubble-show')));
    setTimeout(()=>{ el.classList.add('ls-bubble-hide'); setTimeout(()=>el.remove(),400); },12000);
  }

  function updateFabDisplay(state){
    const dom=getDominantEmotion(state.emotions);
    const iconEl=document.getElementById('ls_fab_icon');
    const barEl =document.getElementById('ls_fab_bar_fill');
    const fab   =document.getElementById('ls_fab');
    if(iconEl) iconEl.textContent=dom.icon;
    if(barEl){ barEl.style.width=(state.emotions[dom.id]||0)+'%'; barEl.style.background=dom.color; barEl.style.boxShadow=`0 0 8px ${dom.color}`; }
    if(fab) fab.style.setProperty('--dom-color',dom.color);
  }

  function clampFab(l,t){ return{ l:clamp(l,FAB_MARGIN,Math.max(FAB_MARGIN,vpW()-68-FAB_MARGIN)), t:clamp(t,FAB_MARGIN,Math.max(FAB_MARGIN,vpH()-68-FAB_MARGIN)) }; }
  function saveFabPos(l,t){ const p=clampFab(l,t); try{ localStorage.setItem(FAB_POS_KEY,JSON.stringify({l:p.l,t:p.t})); }catch{} }
  function applyFabPos(){
    const el=document.getElementById('ls_fab'); if(!el) return;
    try{ const raw=localStorage.getItem(FAB_POS_KEY); if(!raw){setFabDefault();return;} const pos=JSON.parse(raw); const c=clampFab(pos.l,pos.t); el.style.left=c.l+'px'; el.style.top=c.t+'px'; }catch{ setFabDefault(); }
  }
  function setFabDefault(){
    const el=document.getElementById('ls_fab'); if(!el) return;
    const l=clamp(vpW()-76,FAB_MARGIN,vpW()-76), t=clamp(Math.round(vpH()*0.35),FAB_MARGIN,vpH()-76);
    el.style.left=l+'px'; el.style.top=t+'px'; saveFabPos(l,t);
  }

  function ensureFab(){
    if(document.getElementById('ls_fab')) return;
    const div=document.createElement('div'); div.id='ls_fab';
    div.innerHTML=`<button type="button" id="ls_fab_btn" title="Living Soul"><div class="ls-fab-glow"></div><div class="ls-fab-icon" id="ls_fab_icon">🧠</div><div class="ls-fab-bar"><div class="ls-fab-bar-fill" id="ls_fab_bar_fill"></div></div></button><button type="button" id="ls_fab_hide" title="Скрыть">✕</button>`;
    document.body.appendChild(div);
    document.getElementById('ls_fab_btn').addEventListener('click',ev=>{
      if(Date.now()-lastFabDragTs<350){ev.preventDefault();return;} togglePanel();
    });
    document.getElementById('ls_fab_hide').addEventListener('click',()=>{
      getSettings().showFab=false; ctx().saveSettingsDebounced(); renderFab();
    },true);
    initFabDrag(); applyFabPos();
    getSoulState().then(s=>updateFabDisplay(s));
  }

  function renderFab(){
    const s=getSettings(), fab=document.getElementById('ls_fab');
    if(!fab){ if(s.enabled&&s.showFab) ensureFab(); return; }
    if(!s.enabled||!s.showFab){ fab.remove(); return; }
  }

  function initFabDrag(){
    const fab=document.getElementById('ls_fab'), handle=document.getElementById('ls_fab_btn');
    if(!fab||!handle||fab.dataset.drag==='1') return;
    fab.dataset.drag='1';
    let sx,sy,sl,st,moved=false;
    const THRESH=6;
    const onMove=ev=>{
      const dx=ev.clientX-sx, dy=ev.clientY-sy;
      if(!moved&&Math.abs(dx)+Math.abs(dy)>THRESH){ moved=true; fab.classList.add('ls-dragging'); }
      if(!moved) return;
      const p=clampFab(sl+dx,st+dy); fab.style.left=p.l+'px'; fab.style.top=p.t+'px'; fab.style.right=fab.style.bottom='auto';
      ev.preventDefault(); ev.stopPropagation();
    };
    const onEnd=ev=>{
      try{ handle.releasePointerCapture(ev.pointerId); }catch{}
      document.removeEventListener('pointermove',onMove,{passive:false}); document.removeEventListener('pointerup',onEnd);
      if(moved){ lastFabDragTs=Date.now(); saveFabPos(parseFloat(fab.style.left),parseFloat(fab.style.top)); }
      fab.classList.remove('ls-dragging');
    };
    handle.addEventListener('pointerdown',ev=>{
      if(ev.button!==0) return; sx=ev.clientX; sy=ev.clientY; sl=parseFloat(fab.style.left)||0; st=parseFloat(fab.style.top)||0; moved=false;
      handle.setPointerCapture(ev.pointerId); document.addEventListener('pointermove',onMove,{passive:false}); document.addEventListener('pointerup',onEnd);
    });
  }

  function ensurePanel(){
    if(document.getElementById('ls_panel')) return;
    const overlay=document.createElement('div'); overlay.id='ls_overlay';
    overlay.addEventListener('click',ev=>{ if(ev.target===overlay) closePanel(); });
    document.body.appendChild(overlay);
    const panel=document.createElement('div'); panel.id='ls_panel';
    panel.setAttribute('aria-hidden','true');
    panel.innerHTML=`
      <div class="ls-panel-header">
        <div class="ls-panel-title"><span class="ls-title-brain">🧠</span><span>LIVING SOUL</span><span class="ls-title-sub" id="ls_char_name"></span></div>
        <button type="button" class="ls-panel-close" id="ls_panel_close" title="Закрыть">✕</button>
      </div>
      <div class="ls-tabs-row">
        <button class="ls-tab active" data-tab="radar">🕸️ Радар</button>
        <button class="ls-tab" data-tab="thoughts">💭 Мысли</button>
        <button class="ls-tab" data-tab="history">📈 История</button>
        <button class="ls-tab" data-tab="settings">⚙️ Настройки</button>
      </div>
      <div class="ls-panel-body" id="ls_body"></div>`;
    document.body.appendChild(panel);
    document.getElementById('ls_panel_close').addEventListener('click',e=>{ e.stopPropagation(); closePanel(); },true);
    document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&panelOpen) closePanel(); },true);
    panel.querySelectorAll('.ls-tab').forEach(btn=>{
      btn.addEventListener('click',()=>{
        panel.querySelectorAll('.ls-tab').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active'); activeTab=btn.getAttribute('data-tab'); renderPanelContent();
      });
    });
  }

  async function togglePanel(){
    if(panelOpen){ closePanel(); return; }
    panelOpen=true; ensurePanel();
    document.getElementById('ls_overlay')?.classList.add('ls-overlay-open');
    const panel=document.getElementById('ls_panel');
    if(panel){ panel.classList.add('ls-panel-open'); panel.setAttribute('aria-hidden','false'); }
    const nameEl=document.getElementById('ls_char_name');
    if(nameEl) nameEl.textContent=ctx().name2?`— ${ctx().name2}`:'';
    await renderPanelContent();
  }

  function closePanel(){
    panelOpen=false;
    document.getElementById('ls_overlay')?.classList.remove('ls-overlay-open');
    const panel=document.getElementById('ls_panel');
    if(panel){ panel.classList.remove('ls-panel-open'); panel.setAttribute('aria-hidden','true'); }
  }

  async function renderPanelContent(){
    const state=await getSoulState(true);
    const body=document.getElementById('ls_body'); if(!body) return;
    if     (activeTab==='radar')   { body.innerHTML=renderRadarTab(state);    bindRadarEvents(state); }
    else if(activeTab==='thoughts'){ body.innerHTML=renderThoughtsTab(state); }
    else if(activeTab==='history') { body.innerHTML=renderHistoryTab(state);  drawHistoryChart(state); }
    else                           { body.innerHTML=renderSettingsTab();       bindSettingsEvents(); }
  }

  function buildRadarSvg(emotions){
    const cx=150,cy=150,maxR=108, n=EMOTIONS.length, step=(2*Math.PI)/n, start=-Math.PI/2;
    let rings='';
    [0.25,0.5,0.75,1.0].forEach(pct=>{
      const pts=EMOTIONS.map((_,i)=>{ const a=start+i*step,r=maxR*pct; return `${(cx+r*Math.cos(a)).toFixed(1)},${(cy+r*Math.sin(a)).toFixed(1)}`; }).join(' ');
      rings+=`<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.055)" stroke-width="${pct===1?1:0.5}"/>`;
    });
    let axes='';
    EMOTIONS.forEach((_,i)=>{ const a=start+i*step; axes+=`<line x1="${cx}" y1="${cy}" x2="${(cx+maxR*Math.cos(a)).toFixed(1)}" y2="${(cy+maxR*Math.sin(a)).toFixed(1)}" stroke="rgba(255,255,255,0.07)" stroke-width="0.5"/>`; });
    let labels='';
    EMOTIONS.forEach((e,i)=>{ const a=start+i*step, r=maxR+20; labels+=`<text x="${(cx+r*Math.cos(a)).toFixed(1)}" y="${(cy+r*Math.sin(a)).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="19">${e.icon}</text>`; });
    const dataPts=EMOTIONS.map((e,i)=>{ const a=start+i*step, r=maxR*((emotions[e.id]||0)/100); return `${(cx+r*Math.cos(a)).toFixed(1)},${(cy+r*Math.sin(a)).toFixed(1)}`; }).join(' ');
    const dom=getDominantEmotion(emotions);
    let dots='';
    EMOTIONS.forEach((e,i)=>{ const a=start+i*step, r=maxR*((emotions[e.id]||0)/100); dots+=`<circle cx="${(cx+r*Math.cos(a)).toFixed(1)}" cy="${(cy+r*Math.sin(a)).toFixed(1)}" r="3.5" fill="${e.color}" opacity="0.9"/>`; });
    const filters=EMOTIONS.map(e=>`<filter id="gf_${e.id}"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`).join('');
    const mainGlow=`<filter id="mg" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
    return `<defs>${filters}${mainGlow}</defs>${rings}${axes}
      <polygon points="${dataPts}" fill="${dom.color}22" stroke="${dom.color}bb" stroke-width="1.8" stroke-linejoin="round" filter="url(#mg)"/>
      ${dots}${labels}`;
  }

  function renderRadarTab(state){
    const dom=getDominantEmotion(state.emotions);
    const bars=EMOTIONS.map(e=>{
      const val=state.emotions[e.id]||0;
      const trig=TRIGGERS.find(t=>t.emotion===e.id);
      const active=trig&&activeTriggerIds.has(trig.id);
      return `<div class="ls-emo-row${active?' ls-emo-active':''}">
        <span class="ls-emo-icon">${e.icon}</span>
        <span class="ls-emo-name">${e.name}</span>
        <div class="ls-emo-track"><div class="ls-emo-fill" style="width:${val}%;background:${e.color};box-shadow:0 0 6px ${e.color}88"></div></div>
        <span class="ls-emo-val" style="color:${e.color}">${val}</span>
        ${active?`<span class="ls-emo-trigger-dot" title="Триггер активен">⚡</span>`:''}
      </div>`;
    }).join('');
    return `
      <div class="ls-radar-wrap">
        <div class="ls-radar-svg-wrap">
          <svg id="ls_radar_svg" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg">${buildRadarSvg(state.emotions)}</svg>
          <div class="ls-radar-dom" style="color:${dom.color}">${dom.icon} ${dom.name} · ${state.emotions[dom.id]}%</div>
        </div>
        <div class="ls-emo-list">${bars}</div>
      </div>
      ${state.lastThought?`<div class="ls-thought-inline" style="--bc:${EMOTION_MAP[state.lastThoughtEmotion]?.color||'#9966ff'}"><div class="ls-thi-icon">${EMOTION_MAP[state.lastThoughtEmotion]?.icon||'💭'}</div><div class="ls-thi-text">"${escHtml(state.lastThought)}"</div></div>`:''}
      <div class="ls-radar-actions">
        <button class="ls-btn ls-btn-ghost" id="ls_manual_analyze" type="button">🔮 Анализировать</button>
        <button class="ls-btn ls-btn-danger" id="ls_reset_emotions" type="button">↺ Сброс</button>
      </div>`;
  }

  function bindRadarEvents(state){
    document.getElementById('ls_manual_analyze')?.addEventListener('click',async()=>{ showToast('🔮 Анализирую...','info',2000); await onMessageReceived(); },true);
    document.getElementById('ls_reset_emotions')?.addEventListener('click',async()=>{
      const s=await getSoulState(true); Object.assign(s.emotions,emptyState().emotions); s.lastThought='';
      await saveState(); await updateSoulPrompt(); activeTriggerIds.clear(); await updateTriggerPrompt();
      updateFabDisplay(s); await renderPanelContent(); showToast('↺ Эмоции сброшены','info');
    },true);
  }

  function renderThoughtsTab(state){
    if(state.history.length===0) return `<div class="ls-empty">💭 Тайные мысли появятся после первого анализа</div>`;
    const items=[...state.history].reverse().slice(0,20).map(h=>{
      if(!h.thought) return '';
      const dom=getDominantEmotion(h.emotions);
      const time=new Date(h.ts).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
      return `<div class="ls-thought-card" style="--tc:${dom.color}">
        <div class="ls-tc-header"><span>${dom.icon}</span><span class="ls-tc-emo" style="color:${dom.color}">${dom.name}</span><span class="ls-tc-time">${time}</span></div>
        <div class="ls-tc-text">"${escHtml(h.thought)}"</div>
        ${h.shift?`<div class="ls-tc-shift">↳ ${escHtml(h.shift)}</div>`:''}
      </div>`;
    }).filter(Boolean).join('');
    return `<div class="ls-thoughts-list">${items}</div>`;
  }

  function renderHistoryTab(state){
    if(state.history.length<2) return `<div class="ls-empty">📈 Нужно минимум 2 анализа</div>`;
    const checks=EMOTIONS.map(e=>`<label class="ls-hist-toggle"><input type="checkbox" class="ls-hist-check" data-eid="${e.id}" checked><span class="ls-hist-dot" style="background:${e.color}"></span><span>${e.icon} ${e.name}</span></label>`).join('');
    return `<div class="ls-hist-legend">${checks}</div><div class="ls-hist-canvas-wrap"><canvas id="ls_hist_canvas"></canvas></div>`;
  }

  function drawHistoryChart(state){
    const canvas=document.getElementById('ls_hist_canvas'); if(!canvas||state.history.length<2) return;
    const wrap=canvas.parentElement, W=wrap.clientWidth||340, H=220;
    canvas.width=W; canvas.height=H;
    const c=canvas.getContext('2d'); c.clearRect(0,0,W,H);
    const pad={top:10,right:15,bottom:30,left:30}, cW=W-pad.left-pad.right, cH=H-pad.top-pad.bottom;
    const data=state.history, n=data.length;
    // Grid
    c.strokeStyle='rgba(255,255,255,0.05)'; c.lineWidth=0.5;
    [0,25,50,75,100].forEach(v=>{ const y=pad.top+cH-(v/100)*cH; c.beginPath(); c.moveTo(pad.left,y); c.lineTo(pad.left+cW,y); c.stroke(); c.fillStyle='rgba(255,255,255,0.18)'; c.font='9px monospace'; c.fillText(v,2,y+3); });
    const enabled=new Set(); document.querySelectorAll('.ls-hist-check').forEach(cb=>{ if(cb.checked) enabled.add(cb.dataset.eid); });
    for(const e of EMOTIONS){
      if(!enabled.has(e.id)) continue;
      c.beginPath(); c.strokeStyle=e.color; c.lineWidth=1.8; c.shadowColor=e.color; c.shadowBlur=4;
      data.forEach((h,i)=>{ const x=pad.left+(i/(n-1))*cW, y=pad.top+cH-((h.emotions[e.id]||0)/100)*cH; i===0?c.moveTo(x,y):c.lineTo(x,y); });
      c.stroke(); c.shadowBlur=0;
      const lh=data[n-1], lx=pad.left+cW, ly=pad.top+cH-((lh.emotions[e.id]||0)/100)*cH;
      c.beginPath(); c.arc(lx,ly,3,0,Math.PI*2); c.fillStyle=e.color; c.fill();
    }
    document.querySelectorAll('.ls-hist-check').forEach(cb=>{ cb.addEventListener('change',()=>drawHistoryChart(state)); });
  }

  function getSoulStateSync(eid){ return _cachedEmotions?.[eid]??emptyState().emotions[eid]; }

  function renderSettingsTab(){
    const s=getSettings();
    return `<div class="ls-settings">
      <div class="ls-sg"><div class="ls-sg-title">Основное</div>
        <label class="ls-tr"><span>Расширение включено</span><input type="checkbox" id="ls_s_enabled" ${s.enabled?'checked':''}></label>
        <label class="ls-tr"><span>Показывать кнопку</span><input type="checkbox" id="ls_s_showfab" ${s.showFab?'checked':''}></label>
      </div>
      <div class="ls-sg"><div class="ls-sg-title">Анализ</div>
        <label class="ls-tr"><span>AI анализ (Anthropic API)</span><input type="checkbox" id="ls_s_api" ${s.apiEnabled?'checked':''}></label>
        <label class="ls-tr"><span>Всплывающие мысли</span><input type="checkbox" id="ls_s_bubble" ${s.showThoughtBubble?'checked':''}></label>
        <label class="ls-tr"><span>Затухание эмоций</span><input type="checkbox" id="ls_s_decay" ${s.decayEnabled?'checked':''}></label>
      </div>
      <div class="ls-sg"><div class="ls-sg-title">Триггеры поведения</div>
        <label class="ls-tr"><span>Триггеры включены</span><input type="checkbox" id="ls_s_triggers" ${s.triggersEnabled?'checked':''}></label>
        <div class="ls-triggers-list">${TRIGGERS.map(t=>{ const e=EMOTION_MAP[t.emotion]; const act=activeTriggerIds.has(t.id); return `<div class="ls-trig-row${act?' ls-trig-on':''}"><span style="color:${e?.color}">${t.name}</span><span class="ls-trig-cond">${e?.name||''} ${t.dir==='above'?'≥':'≤'} ${t.threshold}</span>${act?'<span class="ls-trig-live">АКТИВЕН</span>':''}</div>`; }).join('')}</div>
      </div>
      <div class="ls-sg"><div class="ls-sg-title">Ручная настройка</div>
        ${EMOTIONS.map(e=>`<div class="ls-manual-row"><span>${e.icon}</span><span class="ls-manual-name">${e.name}</span><input type="range" class="ls-slider" id="ls_sl_${e.id}" min="0" max="100" value="${getSoulStateSync(e.id)}" style="--sc:${e.color}"><span class="ls-slval" id="ls_sv_${e.id}">${getSoulStateSync(e.id)}</span></div>`).join('')}
        <button class="ls-btn ls-btn-primary" id="ls_apply_manual" type="button" style="margin-top:10px">✓ Применить</button>
      </div>
    </div>`;
  }

  function bindSettingsEvents(){
    getSoulState().then(state=>{
      _cachedEmotions=state.emotions;
      EMOTIONS.forEach(e=>{ const sl=document.getElementById(`ls_sl_${e.id}`), vl=document.getElementById(`ls_sv_${e.id}`); if(sl) sl.value=state.emotions[e.id]||0; if(vl) vl.textContent=state.emotions[e.id]||0; sl?.addEventListener('input',()=>{ if(vl) vl.textContent=sl.value; }); });
    });
    const bind=(id,key)=>{ const el=document.getElementById(id); if(!el) return; el.addEventListener('change',()=>{ getSettings()[key]=el.checked; ctx().saveSettingsDebounced(); if(key==='enabled'||key==='showFab') renderFab(); }); };
    bind('ls_s_enabled','enabled'); bind('ls_s_showfab','showFab'); bind('ls_s_api','apiEnabled'); bind('ls_s_bubble','showThoughtBubble'); bind('ls_s_decay','decayEnabled'); bind('ls_s_triggers','triggersEnabled');
    document.getElementById('ls_apply_manual')?.addEventListener('click',async()=>{
      const state=await getSoulState(true);
      EMOTIONS.forEach(e=>{ const sl=document.getElementById(`ls_sl_${e.id}`); if(sl) state.emotions[e.id]=parseInt(sl.value,10); });
      const fired=checkTriggers(state.emotions);
      for(const tr of fired) showToast(`${tr.name} активирован!`,'trigger',4000);
      await updateTriggerPrompt(); await saveState(); await updateSoulPrompt(); updateFabDisplay(state);
      showToast('✅ Эмоции обновлены','success');
    },true);
  }

  function mountSettingsUi(){
    const target=document.getElementById('extensions_settings')||document.getElementById('extension_settings');
    if(!target) return;
    const html=`<div class="extension_block"><div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>🧠 Living Soul</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div></div><div class="inline-drawer-content"><div style="padding:8px;display:flex;flex-direction:column;gap:6px"><label style="display:flex;justify-content:space-between;align-items:center;font-size:13px">Включён<input type="checkbox" id="ls_st_en"></label><label style="display:flex;justify-content:space-between;align-items:center;font-size:13px">Кнопка<input type="checkbox" id="ls_st_sf"></label><button id="ls_st_open" class="menu_button" style="margin-top:4px">Открыть Living Soul</button></div></div></div></div>`;
    const w=document.createElement('div'); w.innerHTML=html; target.appendChild(w.firstChild);
    const s=getSettings();
    const en=document.getElementById('ls_st_en'); if(en){ en.checked=s.enabled; en.addEventListener('change',()=>{ getSettings().enabled=en.checked; ctx().saveSettingsDebounced(); renderFab(); }); }
    const sf=document.getElementById('ls_st_sf'); if(sf){ sf.checked=s.showFab; sf.addEventListener('change',()=>{ getSettings().showFab=sf.checked; ctx().saveSettingsDebounced(); renderFab(); }); }
    document.getElementById('ls_st_open')?.addEventListener('click',()=>togglePanel());
  }

  function wireChatEvents(){
    const EV=SillyTavern.getContext().eventSource;
    const EVENTS=SillyTavern.getContext().event_types;
    EV.on(EVENTS.APP_READY,async()=>{ renderFab(); mountSettingsUi(); const state=await getSoulState(true); await updateSoulPrompt(); updateFabDisplay(state); });
    EV.on(EVENTS.CHAT_CHANGED,async()=>{ activeTriggerIds.clear(); try{ ctx().setExtensionPrompt('LS_TRIGGER','',0,0,true); }catch{} if(panelOpen) await renderPanelContent(); const state=await getSoulState(true); updateFabDisplay(state); await updateSoulPrompt(); });
    EV.on(EVENTS.MESSAGE_RECEIVED,async()=>{ await onMessageReceived(); });
    window.addEventListener('resize',()=>{ if(panelOpen&&activeTab==='history') getSoulState().then(s=>drawHistoryChart(s)); });
  }

  jQuery(()=>{ try{ wireChatEvents(); console.log('[LS] Living Soul v1.0.0 🧠'); }catch(e){ console.error('[LS] init failed',e); } });

})();
