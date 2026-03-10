/**
 * LIVING SOUL — SillyTavern Extension
 * v1.0.0
 *
 * Живые эмоции {{char}} в реальном времени.
 * Радар из 8 осей · Тайные мысли · График настроения · Триггеры поведения
 */

(() => {
  'use strict';

  const MODULE_KEY    = 'living_soul';
  const BEHAVIOR_TAG  = 'LSL_BEHAVIOR';
  const FAB_POS_KEY   = 'lsl_fab_v1';
  const FAB_MARGIN    = 8;
  const EXT_PROMPT_TYPES = Object.freeze({ IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 });

  // ── Emotion definitions ───────────────────────────────────────────────────

  const EMOTIONS = Object.freeze({
    love:        { label: 'Любовь',       icon: '❤️',  color: '#ff4d7d', axis: 0 },
    joy:         { label: 'Радость',      icon: '✨',  color: '#ffd700', axis: 1 },
    trust:       { label: 'Доверие',      icon: '🤝',  color: '#00e5b0', axis: 2 },
    anticipation:{ label: 'Предвкушение', icon: '🌀',  color: '#ff9f43', axis: 3 },
    fear:        { label: 'Страх',        icon: '🌑',  color: '#7f8fff', axis: 4 },
    sadness:     { label: 'Грусть',       icon: '💧',  color: '#6eb5ff', axis: 5 },
    disgust:     { label: 'Отвращение',   icon: '🌿',  color: '#a8e063', axis: 6 },
    anger:       { label: 'Злость',       icon: '🔥',  color: '#ff4500', axis: 7 },
  });

  const EMOTION_KEYS = Object.keys(EMOTIONS);

  // ── Behavior triggers ─────────────────────────────────────────────────────

  const BEHAVIOR_TRIGGERS = Object.freeze({
    love: {
      threshold: 75,
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}} [скрыто от {{user}}]: {{char}} охвачен глубокой любовью. Каждое действие {{user}} воспринимается через призму этого чувства. {{char}} с трудом скрывает нежность — голос теплее, взгляд задерживается дольше обычного, случайные прикосновения кажутся значимыми. Это переполняет изнутри.',
    },
    joy: {
      threshold: 80,
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}} [скрыто]: {{char}} переполнен радостью — искренней, почти детской. Трудно сохранять серьёзность, всё кажется чуть светлее. Энергия ищет выход.',
    },
    trust: {
      threshold: 80,
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}} [скрыто]: {{char}} испытывает глубокое доверие к {{user}}. Защитные барьеры опущены. {{char}} готов сказать то, что обычно не говорит никому.',
    },
    anticipation: {
      threshold: 75,
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}} [скрыто]: {{char}} на взводе от предвкушения — мысли забегают вперёд, тело чуть напряжено, ждёт каждого следующего слова {{user}}.',
    },
    fear: {
      threshold: 70,
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}} [скрыто]: {{char}} охвачен страхом. Инстинкты говорят — опасность. Дыхание участилось, каждое движение {{user}} анализируется. {{char}} ищет выход или спасение, скрывая панику за внешним спокойствием.',
    },
    sadness: {
      threshold: 75,
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}} [скрыто]: {{char}} несёт тяжёлую грусть. Слова даются труднее, паузы длиннее. Что-то внутри сжалось и не отпускает.',
    },
    disgust: {
      threshold: 70,
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}} [скрыто]: {{char}} испытывает сильное отвращение. Каждая реакция слегка сдержана — внутри желание отстраниться, хотя {{char}} этого не показывает напрямую.',
    },
    anger: {
      threshold: 70,
      prompt: 'ВНУТРЕННЕЕ СОСТОЯНИЕ {{char}} [скрыто]: {{char}} кипит от злости. Под поверхностью — вулкан. Слова выбираются с усилием чтобы не сорваться. Одно неверное слово {{user}} может сломать этот контроль.',
    },
  });

  // ── Default settings ──────────────────────────────────────────────────────

  const defaultSettings = Object.freeze({
    enabled:          true,
    showFab:          true,
    autoAnalyze:      true,
    analyzeEvery:     1,
    injectBehavior:   true,
    showInnerThought: true,
    fabScale:         0.9,
    apiEndpoint:      '',
    apiKey:           '',
    apiModel:         'gpt-4o-mini',
    collapsed:        false,
    scanDepth:        8,
  });

  // ── Runtime ───────────────────────────────────────────────────────────────

  let panelOpen      = false;
  let analyzing      = false;
  let lastFabDragTs  = 0;
  let msgCounter     = 0;
  let activeTab      = 'radar';
  let behaviorActive = false;

  // ── ST helpers ────────────────────────────────────────────────────────────

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY])
      extensionSettings[MODULE_KEY] = structuredClone(defaultSettings);
    for (const k of Object.keys(defaultSettings))
      if (!Object.hasOwn(extensionSettings[MODULE_KEY], k))
        extensionSettings[MODULE_KEY][k] = defaultSettings[k];
    return extensionSettings[MODULE_KEY];
  }

  // ── Per-chat state ────────────────────────────────────────────────────────

  function chatKey() {
    const c = ctx();
    const chatId = (typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : null) || c.chatId || 'unknown';
    const charId = c.characterId ?? c.groupId ?? 'unknown';
    return `lsl_v1__${charId}__${chatId}`;
  }

  function emptyEmotions() {
    const e = {};
    for (const k of EMOTION_KEYS) e[k] = 20;
    return e;
  }

  function emptyState() {
    return {
      emotions:     emptyEmotions(),
      history:      [],   // [{msgIdx, emotions, ts}]
      thoughts:     [],   // [{text, ts, msgIdx, dominant}]
      lastAnalyzed: 0,
    };
  }

  async function getState(create = false) {
    const key = chatKey();
    if (!ctx().chatMetadata[key]) {
      if (create) {
        ctx().chatMetadata[key] = emptyState();
        await ctx().saveMetadata();
      } else {
        return emptyState();
      }
    }
    const s = ctx().chatMetadata[key];
    if (!s.emotions)  s.emotions  = emptyEmotions();
    if (!s.history)   s.history   = [];
    if (!s.thoughts)  s.thoughts  = [];
    if (!s.lastAnalyzed) s.lastAnalyzed = 0;
    for (const k of EMOTION_KEYS)
      if (typeof s.emotions[k] !== 'number') s.emotions[k] = 20;
    return s;
  }

  async function saveState() { await ctx().saveMetadata(); }

  // ── Utils ─────────────────────────────────────────────────────────────────

  function escHtml(s) {
    return String(s)
      .replaceAll('&','&amp;').replaceAll('<','&lt;')
      .replaceAll('>','&gt;').replaceAll('"','&quot;');
  }

  function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }
  function vpW() { return window.visualViewport?.width  || window.innerWidth; }
  function vpH() { return window.visualViewport?.height || window.innerHeight; }

  function getDominant(emotions) {
    let best = EMOTION_KEYS[0], bestVal = 0;
    for (const k of EMOTION_KEYS)
      if ((emotions[k] || 0) > bestVal) { bestVal = emotions[k]; best = k; }
    return best;
  }

  function getCharName() {
    const c = ctx();
    try {
      if (c.characterId !== undefined && c.characters?.[c.characterId]?.name)
        return c.characters[c.characterId].name;
      if (c.groupId !== undefined)
        return c.groups?.find?.(g => g.id === c.groupId)?.name ?? '{{char}}';
    } catch {}
    return '{{char}}';
  }

  function getLastMessages(n) {
    const { chat } = ctx();
    if (!Array.isArray(chat) || !chat.length) return '';
    return chat.slice(-n)
      .filter(m => m && !m.is_system && (m.mes || '').trim())
      .map(m => `${m.is_user ? '{{user}}' : (m.name || '{{char}}')}: ${(m.mes||'').trim()}`)
      .join('\n\n');
  }

  // ── AI layer ──────────────────────────────────────────────────────────────

  function getBaseUrl() {
    return (getSettings().apiEndpoint || '').trim()
      .replace(/\/+$/, '').replace(/\/(chat\/completions|completions)$/, '').replace(/\/v1$/, '');
  }

  async function aiGenerate(userPrompt, systemPrompt) {
    const s    = getSettings();
    const base = getBaseUrl();

    if (base) {
      const apiKey  = (s.apiKey || '').trim();
      const headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
      const model   = s.apiModel || 'gpt-4o-mini';
      const urls    = [`${base}/v1/chat/completions`, `${base}/chat/completions`];

      for (const url of urls) {
        try {
          const resp = await fetch(url, {
            method: 'POST', headers,
            body: JSON.stringify({ model, max_tokens: 600, temperature: 0.2,
              messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
          });
          if (!resp.ok) continue;
          const data = await resp.json();
          const text = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text;
          if (text?.trim()) return text;
        } catch {}
      }
    }

    const c = ctx();
    if (typeof c.generateRaw !== 'function') throw new Error('generateRaw недоступен — настрой API в настройках');
    const result = await c.generateRaw(userPrompt, null, false, true, systemPrompt, true);
    if (!result?.trim()) throw new Error('Модель вернула пустой ответ');
    return result;
  }

  // ── Analysis ──────────────────────────────────────────────────────────────

  function buildAnalysisPrompt(charName) {
    return `Ты — психоаналитик RP-персонажей. Анализируй эмоциональное состояние персонажа по его репликам.

ПЕРСОНАЖ: ${charName}

ШКАЛА ЭМОЦИЙ (0–100):
- love: романтическая привязанность, нежность
- joy: радость, удовольствие, восторг
- trust: доверие, открытость, уязвимость
- anticipation: предвкушение, напряжение ожидания
- fear: страх, тревога, паника
- sadness: грусть, тоска, опустошение
- disgust: отвращение, брезгливость, неприятие
- anger: злость, раздражение, ярость

ПРАВИЛА:
- Анализируй ПОДТЕКСТ, не только буквальный смысл
- Все 8 значений обязательны, диапазон 0–100
- innerThought — что {{char}} реально думает/чувствует но НЕ говорит (1–2 предложения, от первого лица)
- delta — краткое описание ключевого эмоционального сдвига за этот обмен (до 8 слов)

Верни ТОЛЬКО валидный JSON без markdown:
{"emotions":{"love":N,"joy":N,"trust":N,"anticipation":N,"fear":N,"sadness":N,"disgust":N,"anger":N},"innerThought":"...","delta":"..."}`;
  }

  function parseAnalysis(raw) {
    if (!raw) return null;
    const clean = raw.replace(/```json|```/gi, '').trim();
    try { const p = JSON.parse(clean); if (p.emotions) return p; } catch {}
    const m = raw.match(/\{[\s\S]+\}/);
    if (m) { try { const p = JSON.parse(m[0]); if (p.emotions) return p; } catch {} }
    return null;
  }

  async function runAnalysis() {
    if (analyzing) return;
    const s     = getSettings();
    if (!s.enabled || !s.autoAnalyze) return;

    const { chat } = ctx();
    if (!Array.isArray(chat) || !chat.length) return;

    const state    = await getState(true);
    const chatLen  = chat.length;
    if (chatLen <= state.lastAnalyzed && state.lastAnalyzed > 0) return;

    analyzing = true;
    updateFabAnalyzing(true);

    try {
      const charName = getCharName();
      const msgs     = getLastMessages(s.scanDepth || 8);
      if (!msgs.trim()) return;

      const system   = buildAnalysisPrompt(charName);
      const user     = `ПОСЛЕДНИЕ РЕПЛИКИ:\n${msgs}\n\nПроанализируй текущее эмоциональное состояние ${charName}. Верни JSON.`;

      const raw      = await aiGenerate(user, system);
      const parsed   = parseAnalysis(raw);
      if (!parsed) { console.warn('[LSL] не удалось распарсить:', raw?.slice(0,120)); return; }

      // Smoothly blend new values (70% new + 30% old for stability)
      for (const k of EMOTION_KEYS) {
        const newVal = clamp(Math.round(parsed.emotions[k] ?? state.emotions[k]), 0, 100);
        state.emotions[k] = Math.round(state.emotions[k] * 0.3 + newVal * 0.7);
      }

      // Store history snapshot
      state.history.push({ msgIdx: chatLen, emotions: { ...state.emotions }, ts: Date.now() });
      if (state.history.length > 120) state.history.shift();

      // Store inner thought
      if (parsed.innerThought?.trim() && s.showInnerThought) {
        const dominant = getDominant(state.emotions);
        state.thoughts.unshift({
          text: parsed.innerThought.trim(),
          delta: parsed.delta || '',
          ts: Date.now(),
          msgIdx: chatLen,
          dominant,
        });
        if (state.thoughts.length > 40) state.thoughts.length = 40;
      }

      state.lastAnalyzed = chatLen;
      await saveState();

      // Inject behavior if triggered
      if (s.injectBehavior) await updateBehaviorPrompt(state);

      // Update UI
      updateFabDominant(state);
      if (panelOpen) await renderPanelContent();

      // Flash notification
      const dom = getDominant(state.emotions);
      const emo = EMOTIONS[dom];
      showPulse(emo.color, emo.icon);

    } catch (e) {
      console.error('[LSL] analysis failed:', e);
    } finally {
      analyzing = false;
      updateFabAnalyzing(false);
    }
  }

  // ── Behavior injection ────────────────────────────────────────────────────

  async function updateBehaviorPrompt(state) {
    const lines = [];
    for (const [emotion, trigger] of Object.entries(BEHAVIOR_TRIGGERS)) {
      if ((state.emotions[emotion] || 0) >= trigger.threshold) {
        lines.push(trigger.prompt);
      }
    }
    const text = lines.join('\n');
    try {
      ctx().setExtensionPrompt(BEHAVIOR_TAG, text, EXT_PROMPT_TYPES.IN_PROMPT, 0, true);
      behaviorActive = lines.length > 0;
    } catch {}
  }

  // ── FAB ───────────────────────────────────────────────────────────────────

  function getFabSize() {
    const sc = getSettings().fabScale ?? 0.9;
    return { W: Math.round(60 * sc) + 10, H: Math.round(52 * sc) + 6 };
  }

  function clampFab(l, t) {
    const { W, H } = getFabSize();
    return {
      l: clamp(l, FAB_MARGIN, Math.max(FAB_MARGIN, vpW() - W - FAB_MARGIN)),
      t: clamp(t, FAB_MARGIN, Math.max(FAB_MARGIN, vpH() - H - FAB_MARGIN)),
    };
  }

  function saveFabPos(l, t) {
    const { W, H } = getFabSize();
    const p = clampFab(l, t);
    const rx = Math.max(1, vpW() - W - FAB_MARGIN * 2);
    const ry = Math.max(1, vpH() - H - FAB_MARGIN * 2);
    try {
      localStorage.setItem(FAB_POS_KEY, JSON.stringify({
        x: (p.l - FAB_MARGIN) / rx, y: (p.t - FAB_MARGIN) / ry, l: p.l, t: p.t,
      }));
    } catch {}
  }

  function applyFabPos() {
    const el = document.getElementById('lsl_fab');
    if (!el) return;
    el.style.transform = 'none'; el.style.right = el.style.bottom = 'auto';
    const { W, H } = getFabSize();
    try {
      const raw = localStorage.getItem(FAB_POS_KEY);
      if (!raw) { setFabDefault(); return; }
      const pos = JSON.parse(raw);
      const l = typeof pos.x === 'number' ? Math.round(pos.x * (vpW() - W - FAB_MARGIN * 2)) + FAB_MARGIN : pos.l;
      const t = typeof pos.y === 'number' ? Math.round(pos.y * (vpH() - H - FAB_MARGIN * 2)) + FAB_MARGIN : pos.t;
      const c = clampFab(l, t);
      el.style.left = c.l + 'px'; el.style.top = c.t + 'px';
    } catch { setFabDefault(); }
  }

  function setFabDefault() {
    const el = document.getElementById('lsl_fab');
    if (!el) return;
    const { W, H } = getFabSize();
    const l = clamp(vpW() - W - FAB_MARGIN - 160, FAB_MARGIN, vpW() - W - FAB_MARGIN);
    const t = clamp(Math.round((vpH() - H) / 2) + 60, FAB_MARGIN, vpH() - H - FAB_MARGIN);
    el.style.left = l + 'px'; el.style.top = t + 'px';
    saveFabPos(l, t);
  }

  function applyFabScale() {
    const btn = document.getElementById('lsl_fab_btn');
    if (!btn) return;
    const sc = getSettings().fabScale ?? 0.9;
    btn.style.transform = `scale(${sc})`;
    btn.style.transformOrigin = 'top left';
    const fab = document.getElementById('lsl_fab');
    if (fab) { fab.style.width = Math.round(60 * sc) + 'px'; fab.style.height = Math.round(52 * sc) + 'px'; }
  }

  function ensureFab() {
    if (document.getElementById('lsl_fab')) return;
    const div = document.createElement('div');
    div.id = 'lsl_fab';
    div.innerHTML = `
      <button type="button" id="lsl_fab_btn" title="Living Soul — эмоции персонажа">
        <div class="lsl-fab-orb" id="lsl_fab_orb">🧠</div>
        <div class="lsl-fab-label" id="lsl_fab_label">душа</div>
      </button>
      <button type="button" id="lsl_fab_hide" title="Скрыть">✕</button>
    `;
    document.body.appendChild(div);

    document.getElementById('lsl_fab_btn').addEventListener('click', ev => {
      if (Date.now() - lastFabDragTs < 350) { ev.preventDefault(); return; }
      togglePanel();
    });
    document.getElementById('lsl_fab_hide').addEventListener('click', async () => {
      getSettings().showFab = false;
      ctx().saveSettingsDebounced();
      document.getElementById('lsl_fab').style.display = 'none';
    });

    initFabDrag();
    applyFabPos();
    applyFabScale();
  }

  function updateFabDominant(state) {
    const dom  = getDominant(state.emotions);
    const emo  = EMOTIONS[dom];
    const orb  = document.getElementById('lsl_fab_orb');
    const lbl  = document.getElementById('lsl_fab_label');
    const fab  = document.getElementById('lsl_fab_btn');
    if (orb) { orb.textContent = emo.icon; orb.style.filter = `drop-shadow(0 0 6px ${emo.color})`; }
    if (lbl) lbl.textContent = emo.label.toLowerCase();
    if (fab) fab.style.setProperty('--lsl-dominant', emo.color);
  }

  function updateFabAnalyzing(on) {
    const fab = document.getElementById('lsl_fab');
    if (fab) fab.classList.toggle('lsl-analyzing', on);
  }

  function showPulse(color, icon) {
    const el = document.createElement('div');
    el.className = 'lsl-pulse-flash';
    el.textContent = icon;
    el.style.setProperty('--pc', color);
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('lsl-pulse-show')));
    setTimeout(() => { el.classList.remove('lsl-pulse-show'); setTimeout(() => el.remove(), 500); }, 2000);
  }

  function initFabDrag() {
    const fab    = document.getElementById('lsl_fab');
    const handle = document.getElementById('lsl_fab_btn');
    if (!fab || !handle || fab.dataset.drag === '1') return;
    fab.dataset.drag = '1';

    let sx, sy, sl, st, moved = false;
    const onMove = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 6) { moved = true; fab.classList.add('lsl-dragging'); }
      if (!moved) return;
      const p = clampFab(sl + dx, st + dy);
      fab.style.left = p.l + 'px'; fab.style.top = p.t + 'px';
      fab.style.right = fab.style.bottom = 'auto';
      ev.preventDefault(); ev.stopPropagation();
    };
    const onEnd = ev => {
      try { handle.releasePointerCapture(ev.pointerId); } catch {}
      document.removeEventListener('pointermove', onMove, { passive: false });
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      if (moved) { saveFabPos(parseInt(fab.style.left)||0, parseInt(fab.style.top)||0); lastFabDragTs = Date.now(); }
      moved = false; fab.classList.remove('lsl-dragging');
    };
    handle.addEventListener('pointerdown', ev => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const { W, H } = getFabSize();
      const curL = parseInt(fab.style.left) || (vpW() - W - FAB_MARGIN - 160);
      const curT = parseInt(fab.style.top)  || Math.round((vpH() - H) / 2);
      const p = clampFab(curL, curT);
      fab.style.left = p.l + 'px'; fab.style.top = p.t + 'px';
      fab.style.right = fab.style.bottom = 'auto'; fab.style.transform = 'none';
      sx = ev.clientX; sy = ev.clientY; sl = p.l; st = p.t; moved = false;
      try { handle.setPointerCapture(ev.pointerId); } catch {}
      document.addEventListener('pointermove', onMove, { passive: false });
      document.addEventListener('pointerup', onEnd, { passive: true });
      document.addEventListener('pointercancel', onEnd, { passive: true });
      ev.preventDefault();
    }, { passive: false });

    let rt = null;
    const onResize = () => { clearTimeout(rt); rt = setTimeout(applyFabPos, 200); };
    window.addEventListener('resize', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
  }

  // ── Panel ─────────────────────────────────────────────────────────────────

  function ensurePanel() {
    if (document.getElementById('lsl_panel')) return;

    const overlay = document.createElement('div');
    overlay.id = 'lsl_overlay';
    overlay.addEventListener('click', ev => { if (ev.target === overlay) closePanel(); });
    document.body.appendChild(overlay);

    const panel = document.createElement('aside');
    panel.id = 'lsl_panel';
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML = `
      <header class="lsl-header">
        <div class="lsl-header-top">
          <div class="lsl-title">
            <span class="lsl-title-orb" id="lsl_title_orb">🧠</span>
            <div>
              <div class="lsl-title-main">LIVING SOUL</div>
              <div class="lsl-title-sub" id="lsl_title_sub">Эмоции персонажа</div>
            </div>
          </div>
          <div class="lsl-header-actions">
            <button type="button" class="lsl-analyze-btn" id="lsl_analyze_btn" title="Анализировать сейчас">⟳</button>
            <button type="button" class="lsl-close-btn"   id="lsl_close_btn"   title="Закрыть">✕</button>
          </div>
        </div>
        <div class="lsl-emotion-strip" id="lsl_strip"></div>
      </header>

      <nav class="lsl-tabs">
        <button class="lsl-tab lsl-tab-active" data-tab="radar">🎯 Радар</button>
        <button class="lsl-tab" data-tab="thoughts">💭 Мысли</button>
        <button class="lsl-tab" data-tab="graph">📈 График</button>
        <button class="lsl-tab" data-tab="triggers">⚡ Триггеры</button>
      </nav>

      <div class="lsl-body" id="lsl_body"></div>
    `;
    document.body.appendChild(panel);

    // Close — capture phase
    document.getElementById('lsl_close_btn').addEventListener('click', e => {
      e.stopPropagation(); closePanel();
    }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && panelOpen) closePanel(); }, true);

    document.getElementById('lsl_analyze_btn').addEventListener('click', async () => {
      const btn = document.getElementById('lsl_analyze_btn');
      if (analyzing) return;
      btn.classList.add('lsl-spinning');
      await runAnalysis();
      btn.classList.remove('lsl-spinning');
    });

    panel.querySelectorAll('.lsl-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.lsl-tab').forEach(b => b.classList.remove('lsl-tab-active'));
        btn.classList.add('lsl-tab-active');
        activeTab = btn.getAttribute('data-tab');
        renderPanelContent();
      });
    });
  }

  async function togglePanel() {
    if (panelOpen) { closePanel(); return; }
    panelOpen = true;
    ensurePanel();
    document.getElementById('lsl_overlay').classList.add('lsl-overlay-open');
    const panel = document.getElementById('lsl_panel');
    panel.classList.add('lsl-panel-open');
    panel.setAttribute('aria-hidden', 'false');
    await renderPanelContent();
  }

  function closePanel() {
    panelOpen = false;
    document.getElementById('lsl_overlay')?.classList.remove('lsl-overlay-open');
    const panel = document.getElementById('lsl_panel');
    if (panel) { panel.classList.remove('lsl-panel-open'); panel.setAttribute('aria-hidden', 'true'); }
  }

  async function renderPanelContent() {
    const state    = await getState();
    const charName = getCharName();
    const dom      = getDominant(state.emotions);
    const emo      = EMOTIONS[dom];

    // Header
    const titleOrb = document.getElementById('lsl_title_orb');
    const titleSub = document.getElementById('lsl_title_sub');
    if (titleOrb) { titleOrb.textContent = emo.icon; titleOrb.style.filter = `drop-shadow(0 0 8px ${emo.color})`; }
    if (titleSub) titleSub.textContent = `${charName} · ${emo.label}`;

    // Emotion strip
    renderStrip(state);

    const body = document.getElementById('lsl_body');
    if (!body) return;

    if      (activeTab === 'radar')    body.innerHTML = renderRadarTab(state);
    else if (activeTab === 'thoughts') body.innerHTML = renderThoughtsTab(state);
    else if (activeTab === 'graph')    { body.innerHTML = renderGraphTab(state); drawGraph(state); }
    else if (activeTab === 'triggers') body.innerHTML = renderTriggersTab(state);
  }

  // ── Emotion strip ─────────────────────────────────────────────────────────

  function renderStrip(state) {
    const strip = document.getElementById('lsl_strip');
    if (!strip) return;
    strip.innerHTML = EMOTION_KEYS.map(k => {
      const emo = EMOTIONS[k];
      const val = state.emotions[k] || 0;
      const pct = val;
      return `
        <div class="lsl-strip-item" title="${emo.label}: ${val}">
          <div class="lsl-strip-bar-bg">
            <div class="lsl-strip-bar-fill" style="height:${pct}%;background:${emo.color};box-shadow:0 0 ${Math.round(pct/15)}px ${emo.color}40"></div>
          </div>
          <div class="lsl-strip-icon">${emo.icon}</div>
          <div class="lsl-strip-val">${val}</div>
        </div>`;
    }).join('');
  }

  // ── Radar tab ─────────────────────────────────────────────────────────────

  function renderRadarTab(state) {
    const dom = getDominant(state.emotions);
    const emo = EMOTIONS[dom];
    const items = EMOTION_KEYS.map(k => {
      const e = EMOTIONS[k];
      const v = state.emotions[k] || 0;
      const width = v;
      const triggered = (BEHAVIOR_TRIGGERS[k]?.threshold || 999) <= v;
      return `
        <div class="lsl-bar-row">
          <div class="lsl-bar-icon" title="${e.label}">${e.icon}</div>
          <div class="lsl-bar-label">${e.label}</div>
          <div class="lsl-bar-track">
            <div class="lsl-bar-fill ${triggered ? 'lsl-bar-triggered' : ''}"
              style="width:${width}%;background:${e.color};box-shadow:${triggered ? `0 0 8px ${e.color}` : 'none'}">
            </div>
          </div>
          <div class="lsl-bar-val ${triggered ? 'lsl-val-triggered' : ''}" style="color:${e.color}">${v}</div>
          ${triggered ? `<div class="lsl-trigger-badge" title="Триггер активен">⚡</div>` : '<div class="lsl-trigger-badge" style="opacity:0">⚡</div>'}
        </div>`;
    }).join('');

    const lastThought = state.thoughts[0];
    const thoughtHtml = lastThought
      ? `<div class="lsl-radar-thought">
          <div class="lsl-thought-label">💭 Последняя мысль</div>
          <div class="lsl-thought-text">"${escHtml(lastThought.text)}"</div>
          ${lastThought.delta ? `<div class="lsl-thought-delta">${escHtml(lastThought.delta)}</div>` : ''}
        </div>`
      : '';

    return `
      <div class="lsl-radar-wrap">
        <div class="lsl-radar-svg-wrap">
          ${buildRadarSvg(state)}
        </div>
        <div class="lsl-bars-wrap">${items}</div>
        ${thoughtHtml}
      </div>`;
  }

  function buildRadarSvg(state) {
    const N   = EMOTION_KEYS.length;
    const CX  = 110, CY = 110, R = 90;
    const step = (Math.PI * 2) / N;

    // Grid rings
    const rings = [25, 50, 75, 100].map(r => {
      const pts = EMOTION_KEYS.map((_, i) => {
        const a = -Math.PI / 2 + i * step;
        const rr = R * r / 100;
        return `${(CX + Math.cos(a) * rr).toFixed(1)},${(CY + Math.sin(a) * rr).toFixed(1)}`;
      }).join(' ');
      return `<polygon points="${pts}" class="lsl-svg-ring"/>`;
    }).join('');

    // Axes
    const axes = EMOTION_KEYS.map((k, i) => {
      const a  = -Math.PI / 2 + i * step;
      const x2 = (CX + Math.cos(a) * R).toFixed(1);
      const y2 = (CY + Math.sin(a) * R).toFixed(1);
      return `<line x1="${CX}" y1="${CY}" x2="${x2}" y2="${y2}" class="lsl-svg-axis"/>`;
    }).join('');

    // Data polygon
    const dataPoints = EMOTION_KEYS.map((k, i) => {
      const a  = -Math.PI / 2 + i * step;
      const v  = (state.emotions[k] || 0) / 100;
      const rr = R * v;
      return `${(CX + Math.cos(a) * rr).toFixed(1)},${(CY + Math.sin(a) * rr).toFixed(1)}`;
    });
    const dom   = getDominant(state.emotions);
    const color = EMOTIONS[dom].color;

    // Labels + icons
    const labels = EMOTION_KEYS.map((k, i) => {
      const a  = -Math.PI / 2 + i * step;
      const d  = R + 18;
      const lx = (CX + Math.cos(a) * d).toFixed(1);
      const ly = (CY + Math.sin(a) * d).toFixed(1);
      return `<text x="${lx}" y="${ly}" class="lsl-svg-label" text-anchor="middle" dominant-baseline="middle">${EMOTIONS[k].icon}</text>`;
    }).join('');

    // Dot on each vertex
    const dots = EMOTION_KEYS.map((k, i) => {
      const [px, py] = dataPoints[i].split(',');
      return `<circle cx="${px}" cy="${py}" r="3" fill="${EMOTIONS[k].color}" opacity="0.9"/>`;
    }).join('');

    return `
      <svg viewBox="0 0 220 220" class="lsl-radar-svg">
        <defs>
          <radialGradient id="lsl_rg" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.18"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
          </radialGradient>
        </defs>
        ${rings}${axes}
        <polygon points="${dataPoints.join(' ')}" fill="url(#lsl_rg)" stroke="${color}" stroke-width="1.5" stroke-opacity="0.85" fill-opacity="0.6"/>
        ${dots}
        ${labels}
      </svg>`;
  }

  // ── Thoughts tab ──────────────────────────────────────────────────────────

  function renderThoughtsTab(state) {
    if (!state.thoughts.length) {
      return `<div class="lsl-empty">
        <div class="lsl-empty-icon">💭</div>
        <div>Тайных мыслей пока нет.<br>После следующего анализа они появятся здесь.</div>
      </div>`;
    }

    const items = state.thoughts.map((t, idx) => {
      const emo   = EMOTIONS[t.dominant] || EMOTIONS.joy;
      const time  = new Date(t.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      const fresh = idx === 0 ? ' lsl-thought-fresh' : '';
      return `
        <div class="lsl-thought-card${fresh}">
          <div class="lsl-thought-card-top">
            <span class="lsl-thought-card-icon">${emo.icon}</span>
            <span class="lsl-thought-card-emo" style="color:${emo.color}">${emo.label}</span>
            <span class="lsl-thought-card-time">${time}</span>
            ${t.delta ? `<span class="lsl-thought-card-delta">· ${escHtml(t.delta)}</span>` : ''}
          </div>
          <div class="lsl-thought-card-text">"${escHtml(t.text)}"</div>
        </div>`;
    }).join('');

    return `
      <div class="lsl-thoughts-wrap">
        <div class="lsl-thoughts-header">
          💭 Тайные мысли персонажа
          <span class="lsl-thoughts-count">${state.thoughts.length}</span>
        </div>
        ${items}
      </div>`;
  }

  // ── Graph tab ─────────────────────────────────────────────────────────────

  function renderGraphTab(state) {
    const legendItems = EMOTION_KEYS.map(k => {
      const e = EMOTIONS[k];
      return `<div class="lsl-legend-item">
        <div class="lsl-legend-dot" style="background:${e.color};box-shadow:0 0 4px ${e.color}"></div>
        <span>${e.icon} ${e.label}</span>
      </div>`;
    }).join('');

    return `
      <div class="lsl-graph-wrap">
        <div class="lsl-graph-title">История эмоций · ${state.history.length} точек</div>
        <div class="lsl-canvas-wrap">
          <canvas id="lsl_graph_canvas" width="340" height="200"></canvas>
          ${!state.history.length ? '<div class="lsl-graph-empty">Нет данных — запусти анализ</div>' : ''}
        </div>
        <div class="lsl-legend">${legendItems}</div>
      </div>`;
  }

  function drawGraph(state) {
    const canvas = document.getElementById('lsl_graph_canvas');
    if (!canvas || !state.history.length) return;

    const W = canvas.width, H = canvas.height;
    const ctx2 = canvas.getContext('2d');
    ctx2.clearRect(0, 0, W, H);

    const pad = { t: 10, r: 10, b: 20, l: 28 };
    const gW  = W - pad.l - pad.r;
    const gH  = H - pad.t - pad.b;
    const n   = state.history.length;

    // Grid
    ctx2.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx2.lineWidth   = 1;
    for (let y = 0; y <= 4; y++) {
      const yp = pad.t + gH - (y / 4) * gH;
      ctx2.beginPath(); ctx2.moveTo(pad.l, yp); ctx2.lineTo(pad.l + gW, yp); ctx2.stroke();
      ctx2.fillStyle = 'rgba(255,255,255,0.25)';
      ctx2.font = '8px monospace';
      ctx2.fillText(y * 25, 2, yp + 3);
    }

    // Lines per emotion
    for (const k of EMOTION_KEYS) {
      const emo = EMOTIONS[k];
      const pts = state.history.map((h, i) => ({
        x: pad.l + (i / Math.max(n - 1, 1)) * gW,
        y: pad.t + gH - ((h.emotions[k] || 0) / 100) * gH,
      }));

      ctx2.beginPath();
      ctx2.strokeStyle = emo.color;
      ctx2.lineWidth   = 1.5;
      ctx2.globalAlpha = 0.75;
      pts.forEach((p, i) => i === 0 ? ctx2.moveTo(p.x, p.y) : ctx2.lineTo(p.x, p.y));
      ctx2.stroke();
    }
    ctx2.globalAlpha = 1;
  }

  // ── Triggers tab ──────────────────────────────────────────────────────────

  function renderTriggersTab(state) {
    const rows = EMOTION_KEYS.map(k => {
      const emo     = EMOTIONS[k];
      const trigger = BEHAVIOR_TRIGGERS[k];
      if (!trigger) return '';
      const active  = (state.emotions[k] || 0) >= trigger.threshold;
      const pct     = Math.min(100, Math.round(((state.emotions[k] || 0) / trigger.threshold) * 100));
      return `
        <div class="lsl-trigger-row ${active ? 'lsl-trigger-active' : ''}">
          <div class="lsl-trigger-top">
            <span class="lsl-trigger-icon">${emo.icon}</span>
            <span class="lsl-trigger-name">${emo.label}</span>
            <span class="lsl-trigger-threshold">порог: ${trigger.threshold}</span>
            <span class="lsl-trigger-cur" style="color:${emo.color}">${state.emotions[k] || 0}</span>
            ${active ? '<span class="lsl-trigger-fire">🔥 АКТИВЕН</span>' : ''}
          </div>
          <div class="lsl-trigger-progress">
            <div class="lsl-trigger-prog-fill" style="width:${pct}%;background:${emo.color};${active ? `box-shadow:0 0 8px ${emo.color}` : ''}"></div>
          </div>
          <div class="lsl-trigger-desc">${escHtml(trigger.prompt.slice(0, 100))}…</div>
        </div>`;
    }).join('');

    const activeCount = EMOTION_KEYS.filter(k => BEHAVIOR_TRIGGERS[k] && (state.emotions[k]||0) >= BEHAVIOR_TRIGGERS[k].threshold).length;

    return `
      <div class="lsl-triggers-wrap">
        <div class="lsl-triggers-header">
          ⚡ Поведенческие триггеры
          <span class="lsl-triggers-active-count ${activeCount > 0 ? 'lsl-tc-on' : ''}">${activeCount} активных</span>
        </div>
        <div class="lsl-triggers-info">
          Когда эмоция достигает порога — {{char}} получает скрытую инструкцию о поведении в следующем ответе.
        </div>
        ${rows}
      </div>`;
  }

  // ── Settings panel ────────────────────────────────────────────────────────

  async function mountSettingsUi() {
    if (document.getElementById('lsl_settings_block')) return;
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) return;

    const s = getSettings();
    const secState = (() => { try { return JSON.parse(localStorage.getItem('lsl_sec')||'{}'); } catch { return {}; } })();
    const saveSec  = () => { try { localStorage.setItem('lsl_sec', JSON.stringify(secState)); } catch {} };

    const sec = (id, icon, title, content, defOpen = false) => {
      const open = secState[id] !== undefined ? secState[id] : defOpen;
      return `
        <div class="lsl-sec" id="lsl_sec_${id}">
          <div class="lsl-sec-hdr" data-sec="${id}">
            <span class="lsl-sec-chev">${open?'▾':'▸'}</span>${icon} ${title}
          </div>
          <div class="lsl-sec-body"${open?'':' style="display:none"'}>${content}</div>
        </div>`;
    };

    const secMain = `
      <div class="lsl-2col">
        <label class="lsl-ck"><input type="checkbox" id="lsl_enabled" ${s.enabled?'checked':''}><span>Активно</span></label>
        <label class="lsl-ck"><input type="checkbox" id="lsl_show_fab" ${s.showFab?'checked':''}><span>Виджет 🧠</span></label>
        <label class="lsl-ck"><input type="checkbox" id="lsl_auto_analyze" ${s.autoAnalyze?'checked':''}><span>Авто-анализ</span></label>
        <label class="lsl-ck"><input type="checkbox" id="lsl_inject_beh" ${s.injectBehavior?'checked':''}><span>Триггеры поведения</span></label>
        <label class="lsl-ck"><input type="checkbox" id="lsl_inner_thought" ${s.showInnerThought?'checked':''}><span>Тайные мысли</span></label>
      </div>
      <div class="lsl-srow lsl-slider-row">
        <label>Анализ каждые:</label>
        <input type="range" id="lsl_every" min="1" max="10" step="1" value="${s.analyzeEvery||1}">
        <span id="lsl_every_val">${s.analyzeEvery||1}</span><span style="opacity:.45;font-size:10px">сообщ.</span>
      </div>
      <div class="lsl-srow lsl-slider-row">
        <label>Глубина скана:</label>
        <input type="range" id="lsl_depth" min="3" max="20" step="1" value="${s.scanDepth||8}">
        <span id="lsl_depth_val">${s.scanDepth||8}</span><span style="opacity:.45;font-size:10px">сообщ.</span>
      </div>
      <div class="lsl-srow lsl-slider-row">
        <label>Размер кнопки:</label>
        <input type="range" id="lsl_scale" min="0.5" max="1.5" step="0.1" value="${s.fabScale??0.9}">
        <span id="lsl_scale_val">${Math.round((s.fabScale??0.9)*100)}%</span>
      </div>
      <div class="lsl-compact-btns">
        <button class="menu_button" id="lsl_open_panel_btn">🧠 Открыть панель</button>
        <button class="menu_button" id="lsl_analyze_now_btn">⟳ Анализировать</button>
        <button class="menu_button" id="lsl_reset_btn">🗑 Сбросить эмоции</button>
      </div>`;

    const hasApi = !!(s.apiEndpoint || '').trim();
    const secApi = `
      <div class="lsl-api-mode-bar">
        <button class="lsl-api-btn ${!hasApi?'lsl-api-active':''}" data-mode="st">🟢 ST (текущий)</button>
        <button class="lsl-api-btn ${hasApi?'lsl-api-active':''}" data-mode="custom">🔌 Кастомный API</button>
      </div>
      <div id="lsl_mode_st" ${hasApi?'style="display:none"':''}>
        <div class="lsl-api-st-info">✅ Используется модель подключённая в ST. Всё работает из коробки.</div>
      </div>
      <div id="lsl_mode_custom" ${!hasApi?'style="display:none"':''}>
        <input type="text" id="lsl_api_ep" class="lsl-api-field" placeholder="https://api.openai.com/v1" value="${escHtml(s.apiEndpoint||'')}">
        <input type="password" id="lsl_api_key" class="lsl-api-field" placeholder="API Key" value="${s.apiKey||''}" style="margin-top:4px">
        <input type="text" id="lsl_api_model" class="lsl-api-field" placeholder="gpt-4o-mini" value="${escHtml(s.apiModel||'gpt-4o-mini')}" style="margin-top:4px">
      </div>`;

    $(target).append(`
      <div class="lsl-settings-block" id="lsl_settings_block">
        <div class="lsl-settings-title">
          <span>🧠 Living Soul</span>
          <button type="button" id="lsl_collapse_btn">${s.collapsed?'▸':'▾'}</button>
        </div>
        <div class="lsl-settings-body"${s.collapsed?' style="display:none"':''}>
          ${sec('main', '⚙️', 'Основное', secMain, true)}
          ${sec('api',  '🔌', 'API',      secApi,  false)}
        </div>
      </div>
    `);

    // Accordion
    $(document).off('click.lsl_sec').on('click.lsl_sec', '.lsl-sec-hdr', function () {
      const id = this.getAttribute('data-sec');
      const body = $(this).next('.lsl-sec-body');
      const open = body.is(':visible');
      body.toggle(!open);
      $(this).find('.lsl-sec-chev').text(open?'▸':'▾');
      secState[id] = !open; saveSec();
    });

    $('#lsl_collapse_btn').on('click', () => {
      s.collapsed = !s.collapsed;
      $('#lsl_settings_block .lsl-settings-body').toggle(!s.collapsed);
      $('#lsl_collapse_btn').text(s.collapsed?'▸':'▾');
      ctx().saveSettingsDebounced();
    });

    // Checkboxes
    $('#lsl_enabled').on('input',       ev => { s.enabled          = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); });
    $('#lsl_show_fab').on('input', async ev => { s.showFab         = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); document.getElementById('lsl_fab').style.display = s.showFab ? '' : 'none'; });
    $('#lsl_auto_analyze').on('input',  ev => { s.autoAnalyze      = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); });
    $('#lsl_inject_beh').on('input',    ev => { s.injectBehavior   = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); });
    $('#lsl_inner_thought').on('input', ev => { s.showInnerThought = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); });

    $('#lsl_every').on('input',  ev => { const v=+$(ev.currentTarget).val(); s.analyzeEvery=v; $('#lsl_every_val').text(v); ctx().saveSettingsDebounced(); });
    $('#lsl_depth').on('input',  ev => { const v=+$(ev.currentTarget).val(); s.scanDepth=v;    $('#lsl_depth_val').text(v); ctx().saveSettingsDebounced(); });
    $('#lsl_scale').on('input',  ev => {
      const v=parseFloat($(ev.currentTarget).val()); s.fabScale=v;
      $('#lsl_scale_val').text(Math.round(v*100)+'%');
      ctx().saveSettingsDebounced(); applyFabScale(); applyFabPos();
    });

    $(document).off('click.lsl_apimode').on('click.lsl_apimode', '.lsl-api-btn', function () {
      const mode = this.getAttribute('data-mode');
      document.querySelectorAll('.lsl-api-btn').forEach(b => b.classList.remove('lsl-api-active'));
      this.classList.add('lsl-api-active');
      if (mode === 'st') {
        $('#lsl_mode_st').show(); $('#lsl_mode_custom').hide();
        s.apiEndpoint = ''; s.apiKey = ''; ctx().saveSettingsDebounced();
      } else {
        $('#lsl_mode_st').hide(); $('#lsl_mode_custom').show();
      }
    });

    $('#lsl_api_ep').on('input',    () => { s.apiEndpoint = $('#lsl_api_ep').val().trim(); ctx().saveSettingsDebounced(); });
    $('#lsl_api_key').on('input',   () => { s.apiKey      = $('#lsl_api_key').val().trim(); ctx().saveSettingsDebounced(); });
    $('#lsl_api_model').on('input', () => { s.apiModel    = $('#lsl_api_model').val().trim(); ctx().saveSettingsDebounced(); });

    $('#lsl_open_panel_btn').on('click',  () => togglePanel());
    $('#lsl_analyze_now_btn').on('click', async () => { await runAnalysis(); });
    $('#lsl_reset_btn').on('click', async () => {
      const state = await getState(true);
      state.emotions  = emptyEmotions();
      state.history   = [];
      state.thoughts  = [];
      state.lastAnalyzed = 0;
      await saveState();
      const fab = document.getElementById('lsl_fab');
      if (fab) {
        const orb = document.getElementById('lsl_fab_orb');
        const lbl = document.getElementById('lsl_fab_label');
        if (orb) { orb.textContent = '🧠'; orb.style.filter = ''; }
        if (lbl) lbl.textContent = 'душа';
      }
      if (panelOpen) await renderPanelContent();
    });
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  function wireChatEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async () => {
      ensureFab(); applyFabPos(); applyFabScale();
      await mountSettingsUi();
      const s = getSettings();
      if (!s.enabled || !s.showFab) document.getElementById('lsl_fab').style.display = 'none';
      const state = await getState();
      updateFabDominant(state);
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
      msgCounter = 0;
      behaviorActive = false;
      try { ctx().setExtensionPrompt(BEHAVIOR_TAG, '', EXT_PROMPT_TYPES.IN_PROMPT, 0, true); } catch {}
      const state = await getState();
      updateFabDominant(state);
      if (panelOpen) await renderPanelContent();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
      const s = getSettings();
      if (!s.enabled) return;
      msgCounter++;
      if (s.autoAnalyze && msgCounter >= (s.analyzeEvery || 1)) {
        msgCounter = 0;
        await runAnalysis();
      }
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  jQuery(() => {
    try {
      wireChatEvents();
      console.log('[LSL] Living Soul v1.0.0 загружен');
    } catch (e) {
      console.error('[LSL] init failed', e);
    }
  });

})();
