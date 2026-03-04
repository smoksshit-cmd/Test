(() => {
  'use strict';

  const MODULE_KEY = 'janitor_script_importer';

  const defaultSettings = Object.freeze({
    enabled: true,
    autoDetectInChat: true,
    allowServerProxyFallback: true, // попробует /api/assets/download если прямой fetch упадёт
    namePrefix: 'Janitor - ',
  });

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY]) {
      extensionSettings[MODULE_KEY] = structuredClone(defaultSettings);
    }
    for (const k of Object.keys(defaultSettings)) {
      if (!Object.hasOwn(extensionSettings[MODULE_KEY], k)) {
        extensionSettings[MODULE_KEY][k] = defaultSettings[k];
      }
    }
    return extensionSettings[MODULE_KEY];
  }

  function escHtml(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function uuid() {
    try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  }

  function isJanitorScriptsUrl(url) {
    return typeof url === 'string' && /https?:\/\/(www\.)?janitorai\.com\/scripts\/[a-f0-9\-]{36}/i.test(url);
  }

  function extractUuidFromUrl(url) {
    const m = String(url).match(/\/scripts\/([a-f0-9\-]{36})/i);
    return m ? m[1] : null;
  }

  // ---------- UI (в Extensions panel, как у FMT) ----------

  async function mountSettingsUi() {
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) return;
    if ($('#jsi_settings_block').length) return;

    const s = getSettings();

    $(target).append(`
      <div id="jsi_settings_block">
        <div class="jsi_title">📥 Janitor Script → World Info</div>

        <div class="jsi_row">
          <input type="text" id="jsi_url" placeholder="https://janitorai.com/scripts/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          <button class="menu_button" id="jsi_import_btn">Импорт</button>
        </div>

        <div class="jsi_row">
          <label class="jsi_ck">
            <input type="checkbox" id="jsi_enabled" ${s.enabled ? 'checked' : ''}>
            <span>Включено</span>
          </label>

          <label class="jsi_ck" style="margin-left:10px">
            <input type="checkbox" id="jsi_autodetect" ${s.autoDetectInChat ? 'checked' : ''}>
            <span>Авто-подсказка при ссылке в чате</span>
          </label>
        </div>

        <div class="jsi_row">
          <label class="jsi_ck">
            <input type="checkbox" id="jsi_proxy_fallback" ${s.allowServerProxyFallback ? 'checked' : ''}>
            <span>Fallback через сервер ST (если CORS/Cloudflare мешает)</span>
          </label>
        </div>

        <div class="jsi_help">
          Поддерживает ссылки вида <span class="jsi_small"><code>janitorai.com/scripts/UUID</code></span>.<br>
          Импорт создаёт новый World Info (лорбук) и кладёт туда entries.
        </div>

        <div class="jsi_status" id="jsi_status"></div>
      </div>
    `);

    $('#jsi_enabled').on('change', () => {
      getSettings().enabled = $('#jsi_enabled').prop('checked');
      ctx().saveSettingsDebounced();
    });

    $('#jsi_autodetect').on('change', () => {
      getSettings().autoDetectInChat = $('#jsi_autodetect').prop('checked');
      ctx().saveSettingsDebounced();
    });

    $('#jsi_proxy_fallback').on('change', () => {
      getSettings().allowServerProxyFallback = $('#jsi_proxy_fallback').prop('checked');
      ctx().saveSettingsDebounced();
    });

    $('#jsi_import_btn').on('click', async () => {
      const url = String($('#jsi_url').val() ?? '').trim();
      await importFromUrlFlow(url);
    });

    $('#jsi_url').on('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const url = String($('#jsi_url').val() ?? '').trim();
        await importFromUrlFlow(url);
      }
    });
  }

  function setStatus(t) {
    $('#jsi_status').text(t ? String(t) : '');
  }

  // ---------- Основной флоу ----------

  async function importFromUrlFlow(url) {
    const s = getSettings();
    if (!s.enabled) { toastr.warning('[JSI] Расширение отключено'); return; }

    if (!isJanitorScriptsUrl(url)) {
      toastr.error('[JSI] Нужна ссылка вида https://janitorai.com/scripts/<UUID>');
      return;
    }

    const id = extractUuidFromUrl(url);
    if (!id) { toastr.error('[JSI] Не смог вытащить UUID из ссылки'); return; }

    setStatus('Скачиваю script…');

    try {
      const raw = await fetchJanitorScriptData(id, url);
      setStatus('Парсю entries…');

      const { title, entries } = normalizeJanitorScript(raw, id);

      if (!entries.length) {
        throw new Error('Entries не найдены (Janitor вернул пусто или формат изменился)');
      }

      setStatus('Создаю World Info…');
      const worldName = await createWorldInfoBook(title);

      setStatus('Записываю entries…');
      await fillWorldInfoBook(worldName, entries);

      setStatus(`Готово: ${worldName} (${entries.length} entries)`);
      toastr.success(`✅ Импортировано: ${worldName} (${entries.length})`);

    } catch (e) {
      console.error('[JSI] import failed', e);
      setStatus('Ошибка импорта');
      toastr.error(`[JSI] ${e?.message || e}`);
    }
  }

  // ---------- Загрузка Janitor ----------

  async function fetchText(url, useProxyIfNeeded) {
    // 1) прямой fetch (если CORS позволяет)
    try {
      const r = await fetch(url, { method: 'GET' });
      if (r.ok) return await r.text();
    } catch (_) {}

    // 2) fallback через сервер ST (если включено)
    if (!useProxyIfNeeded) {
      throw new Error('Direct fetch blocked (CORS/Cloudflare). Включи fallback через сервер ST.');
    }

    // Важно: ограничиваемся только janitorai.com, чтобы не превратить это в SSRF-инструмент.
    if (!/^https?:\/\/(www\.)?janitorai\.com\//i.test(url)) {
      throw new Error('Proxy fallback разрешён только для janitorai.com');
    }

    // В ST существует endpoint /api/assets/download (используется для скачивания ассетов).
    // Мы используем его как “серверный fetch” и берём ответ как текст.
    const resp = await fetch('/api/assets/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        category: 'world',
        filename: `janitor_${Date.now()}.txt`,
      }),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Proxy download failed: ${resp.status} ${resp.statusText} ${t}`.trim());
    }

    return await resp.text();
  }

  async function fetchJson(url, useProxyIfNeeded) {
    const text = await fetchText(url, useProxyIfNeeded);
    try { return JSON.parse(text); }
    catch {
      // иногда сервер отдаёт не чистый JSON (редко), тогда пробуем вытащить JSON из текста
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error('Не смог распарсить JSON');
    }
  }

  async function fetchJanitorScriptData(uuid36, originalUrl) {
    const s = getSettings();
    const useProxy = !!s.allowServerProxyFallback;

    // Пробуем несколько JSON endpoint’ов (у Janitor они менялись)
    const candidates = [
      `https://janitorai.com/api/scripts/${uuid36}`,
      `https://janitorai.com/api/script/${uuid36}`,
      // иногда всё лежит на самой странице (__NEXT_DATA__)
      originalUrl,
    ];

    // 1) попытка JSON endpoint’ов
    for (const u of candidates.slice(0, 2)) {
      try {
        const data = await fetchJson(u, useProxy);
        if (data && typeof data === 'object') return data;
      } catch (_) {}
    }

    // 2) HTML страница + __NEXT_DATA__
    const html = await fetchText(originalUrl, useProxy);
    const next = extractNextData(html);
    if (next) return next;

    // 3) последняя попытка: выдрать самый большой JSON-объект (на случай другого шаблона)
    const bigJson = extractLargestJsonObject(html);
    if (bigJson) return bigJson;

    throw new Error('Не смог получить данные script (ни API, ни __NEXT_DATA__)');
  }

  function extractNextData(html) {
    const m = String(html).match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return null;
    try {
      const obj = JSON.parse(m[1]);
      // Внутри props.pageProps часто лежат нужные данные.
      const found = deepFindLikelyScript(obj);
      return found || obj;
    } catch {
      return null;
    }
  }

  function extractLargestJsonObject(html) {
    const txt = String(html);
    // Находим большие JSON-куски по простому эвристическому правилу
    const matches = [...txt.matchAll(/\{[\s\S]{2000,}\}/g)];
    if (!matches.length) return null;

    // Берём самый длинный и пробуем распарсить
    matches.sort((a, b) => b[0].length - a[0].length);
    for (const m of matches.slice(0, 3)) {
      try { return JSON.parse(m[0]); } catch {}
    }
    return null;
  }

  function deepFindLikelyScript(obj) {
    // Ищем объект, похожий на script: name/title + entries array
    const stack = [obj];
    const seen = new Set();

    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      const entries =
        cur.entries ||
        cur.lorebook?.entries ||
        cur.script?.entries ||
        cur.data?.entries;

      const title =
        cur.name || cur.title || cur.script?.name || cur.script?.title || cur.data?.name || cur.data?.title;

      if (title && Array.isArray(entries)) {
        return cur;
      }

      for (const v of Object.values(cur)) {
        if (v && typeof v === 'object') stack.push(v);
      }
    }

    return null;
  }

  // ---------- Нормализация в формат ST World Info ----------

  function normalizeJanitorScript(raw, uuid36) {
    const root = deepFindLikelyScript(raw) || raw;

    const title =
      root.name ||
      root.title ||
      root.script?.name ||
      root.script?.title ||
      root.data?.name ||
      root.data?.title ||
      `Script ${uuid36.slice(0, 8)}`;

    const sourceEntries =
      (Array.isArray(root.entries) && root.entries) ||
      (Array.isArray(root.script?.entries) && root.script.entries) ||
      (Array.isArray(root.lorebook?.entries) && root.lorebook.entries) ||
      (Array.isArray(root.data?.entries) && root.data.entries) ||
      [];

    const entries = [];
    for (const e of sourceEntries) {
      if (!e || typeof e !== 'object') continue;

      const keys = normalizeKeys(
        e.keywords ?? e.keys ?? e.triggers ?? e.trigger ?? e.triggerWords ?? e.activation ?? e.match ?? []
      );

      const content = String(e.content ?? e.text ?? e.body ?? e.description ?? e.value ?? '').trim();
      const comment = String(e.name ?? e.title ?? e.comment ?? e.memo ?? '').trim();

      if (!content && !keys.length) continue;

      entries.push({
        uid: uuid(),
        key: keys.length ? keys : ['*'], // чтобы не потерять entry без ключей
        comment,
        content,
        order: clampInt(e.order ?? e.priority ?? e.weight ?? 100, 0, 9999),
        constant: !!e.constant,
        vectorized: !!e.vectorized,
        disable: !!e.disable,
      });
    }

    return { title, entries };
  }

  function normalizeKeys(v) {
    if (Array.isArray(v)) {
      return v.map(x => String(x).trim()).filter(Boolean);
    }
    const s = String(v ?? '').trim();
    if (!s) return [];
    // поддержка "a, b; c"
    return s.split(/[,;|\n]/g).map(x => x.trim()).filter(Boolean);
  }

  function clampInt(v, mn, mx) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 100;
    return Math.max(mn, Math.min(mx, Math.round(n)));
  }

  // ---------- Запись в World Info через внутренние модули ST ----------

  async function getWorldInfoApi() {
    // world-info.js — официальный внутренний модуль ST, как в больших аддонах (WorldInfoDrawer и т.п.)
    // dynamic import, чтобы не зависеть от типа загрузчика.
    return await import('../../../world-info.js');
  }

  async function createWorldInfoBook(title) {
    const s = getSettings();
    const wi = await getWorldInfoApi();

    const name = sanitizeWorldName(`${s.namePrefix || ''}${title}`);

    // createNewWorldInfo умеет интерактив (Popup), но нам лучше без вопросов:
    // если файла нет — создаст, если есть — добавим суффикс.
    const finalName = await getFreeWorldName(wi, name);

    const created = await wi.createNewWorldInfo(finalName, { interactive: false });
    if (!created) {
      // если createNewWorldInfo вернул false (например уже есть), всё равно продолжаем
      // но гарантируем существование
      // (в некоторых версиях ST createNewWorldInfo может возвращать void)
    }
    return finalName;
  }

  async function fillWorldInfoBook(worldName, entries) {
    const wi = await getWorldInfoApi();
    const book = await wi.loadWorldInfo(worldName);

    // book.entries — объект uid -> entry
    // создаём через createWorldInfoEntry, чтобы ST заполнил дефолты корректно
    for (const e of entries) {
      const dst = wi.createWorldInfoEntry(null, book);
      dst.key = Array.isArray(e.key) ? e.key : ['*'];
      dst.comment = e.comment || '';
      dst.content = e.content || '';
      dst.order = Number.isFinite(+e.order) ? +e.order : 100;
      dst.constant = !!e.constant;
      dst.vectorized = !!e.vectorized;
      dst.disable = !!e.disable;
    }

    // saveWorldInfo(name, data, silent)
    await wi.saveWorldInfo(worldName, book, true);
  }

  async function getFreeWorldName(wi, baseName) {
    // wi.world_names — массив существующих книг
    const existing = new Set((wi.world_names || []).map(x => String(x).toLowerCase()));
    if (!existing.has(String(baseName).toLowerCase())) return baseName;

    for (let i = 2; i < 999; i++) {
      const cand = `${baseName} (${i})`;
      if (!existing.has(cand.toLowerCase())) return cand;
    }
    return `${baseName} (${Date.now()})`;
  }

  function sanitizeWorldName(name) {
    // максимально мягко, чтобы не поломать сохранение файла
    return String(name)
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || `Janitor - ${Date.now()}`;
  }

  // ---------- Авто-подсказка по ссылке в чате ----------

  function hookChatAutoDetect() {
    // Логика простая: если в сообщении пользователя есть janitor /scripts — покажем toast с кнопкой импорт.
    // Мы НЕ делаем скрытый автоскач — только подсказка.
    const s = getSettings();
    if (!s.autoDetectInChat) return;

    $(document).off('message_sent.jsi').on('message_sent.jsi', async (_ev, data) => {
      try {
        if (!getSettings().enabled || !getSettings().autoDetectInChat) return;

        const text = String(data?.mes ?? data?.message ?? '').trim();
        if (!text) return;

        const m = text.match(/https?:\/\/(www\.)?janitorai\.com\/scripts\/[a-f0-9\-]{36}/i);
        if (!m) return;

        const url = m[0];
        const $btn = $(`<button class="menu_button" style="margin-left:8px;padding:2px 10px;font-size:11px">Импорт</button>`);
        $btn.on('click', async () => {
          $('#jsi_url').val(url);
          await importFromUrlFlow(url);
        });

        toastr.info(
          $('<span>Найдена ссылка Janitor Script.</span>').append($btn),
          'JSI',
          { timeOut: 8000, escapeHtml: false }
        );
      } catch {}
    });
  }

  // ---------- Init ----------

  jQuery(async () => {
    try {
      getSettings(); // init
      await mountSettingsUi();
      hookChatAutoDetect();
      console.log('[JSI] Loaded');
    } catch (e) {
      console.error('[JSI] init failed', e);
    }
  });

})();
