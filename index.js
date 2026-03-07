/**
 * Chat Organizer (CO) — SillyTavern Extension
 * v1.0.0
 *
 * Заметки, теги, пин и поиск прямо в списке чатов.
 * Встраивается в .character_select без отдельного интерфейса.
 */

(() => {
  'use strict';

  const MODULE_KEY = 'chat_organizer';

  const PRESET_TAGS = Object.freeze([
    { id: 'active',   label: '🔴 Активный',  color: '#d44' },
    { id: 'paused',   label: '🟡 Пауза',      color: '#b83' },
    { id: 'done',     label: '🟢 Завершён',   color: '#3a7' },
    { id: 'fav',      label: '💜 Любимый',    color: '#95c' },
    { id: 'serious',  label: '🔵 Серьёзный',  color: '#46b' },
    { id: 'casual',   label: '⚪ Лёгкий',     color: '#777' },
  ]);

  let searchQuery  = '';
  let filterPinned = false;
  let filterTag    = null;
  let listObserver = null;

  // ─── Context ──────────────────────────────────────────────────────────────────

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY])
      extensionSettings[MODULE_KEY] = { chars: {}, collapsed: false };
    if (!extensionSettings[MODULE_KEY].chars)
      extensionSettings[MODULE_KEY].chars = {};
    return extensionSettings[MODULE_KEY];
  }

  function getCharData(chid) {
    const s   = getSettings();
    const key = String(chid);
    if (!s.chars[key]) s.chars[key] = { note: '', tags: [], pinned: false };
    return s.chars[key];
  }

  function save() { ctx().saveSettingsDebounced(); }

  // ─── Utils ────────────────────────────────────────────────────────────────────

  function escHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function formatDate(ts) {
    if (!ts) return '';
    // ST stores date_last_chat as unix seconds sometimes, ms other times
    const ms  = ts > 1e12 ? ts : ts * 1000;
    const d   = new Date(ms);
    const now = new Date();
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays === 0) return 'сегодня';
    if (diffDays === 1) return 'вчера';
    if (diffDays < 7)  return `${diffDays} дн. назад`;
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }

  // ─── Toolbar ──────────────────────────────────────────────────────────────────

  function ensureToolbar() {
    if ($('#co_toolbar').length) return;
    const $target = $('#rm_print_characters_block');
    if (!$target.length) return;

    const tagButtons = PRESET_TAGS.map(t =>
      `<button class="co-tag-filter" data-tag="${t.id}"
        style="--co-tag-color:${t.color}">
        ${t.label}
      </button>`
    ).join('');

    const $toolbar = $(`
      <div id="co_toolbar">
        <div class="co-search-row">
          <input type="text" id="co_search" placeholder="🔍 Поиск по чатам и заметкам…" autocomplete="off">
          <button id="co_filter_pinned" title="Только закреплённые">📌</button>
          <button id="co_reset_filters" title="Сбросить фильтры">✕</button>
        </div>
        <div id="co_tag_filters" class="co-tag-filters">
          ${tagButtons}
        </div>
      </div>
    `);

    $toolbar.insertBefore($target);

    $('#co_search').on('input', function () {
      searchQuery = this.value.toLowerCase().trim();
      applyFilters();
    });

    $('#co_filter_pinned').on('click', function () {
      filterPinned = !filterPinned;
      $(this).toggleClass('active', filterPinned);
      applyFilters();
    });

    $('#co_reset_filters').on('click', () => {
      searchQuery  = '';
      filterPinned = false;
      filterTag    = null;
      $('#co_search').val('');
      $('#co_filter_pinned').removeClass('active');
      $('.co-tag-filter').removeClass('active');
      applyFilters();
    });

    $(document).off('click.co_tagfilter').on('click.co_tagfilter', '.co-tag-filter', function () {
      const tag = this.getAttribute('data-tag');
      if (filterTag === tag) {
        filterTag = null;
        $(this).removeClass('active');
      } else {
        filterTag = tag;
        $('.co-tag-filter').removeClass('active');
        $(this).addClass('active');
      }
      applyFilters();
    });
  }

  // ─── Filters ──────────────────────────────────────────────────────────────────

  function applyFilters() {
    const { characters } = ctx();

    document.querySelectorAll('.character_select[chid]').forEach(el => {
      const chid = el.getAttribute('chid');
      const char = characters?.[chid];
      if (!char) return;

      const data = getCharData(chid);

      const q       = searchQuery;
      const nameOk  = !q || (char.name || '').toLowerCase().includes(q);
      const noteOk  = !q || (data.note || '').toLowerCase().includes(q);
      const lastOk  = !q || (char.last_mes || '').toLowerCase().includes(q);
      const srchOk  = nameOk || noteOk || lastOk;

      const pinnedOk = !filterPinned || !!data.pinned;
      const tagOk    = !filterTag    || (data.tags || []).includes(filterTag);

      const visible = srchOk && pinnedOk && tagOk;
      el.style.display = visible ? '' : 'none';
    });

    sortPinnedToTop();
  }

  function sortPinnedToTop() {
    const list = document.getElementById('rm_print_characters_block');
    if (!list) return;
    const items = [...list.querySelectorAll('.character_select[chid]')];
    // Move pinned to top, preserving relative order within each group
    const pinned   = items.filter(el => getCharData(el.getAttribute('chid')).pinned);
    const unpinned = items.filter(el => !getCharData(el.getAttribute('chid')).pinned);
    [...pinned, ...unpinned].forEach(el => list.appendChild(el));
  }

  // ─── Card overlay injection ───────────────────────────────────────────────────

  function buildOverlayHtml(chid) {
    const { characters } = ctx();
    const char = characters?.[chid];
    if (!char) return '';

    const data    = getCharData(chid);
    const lastMes = (char.last_mes || '').replace(/<[^>]*>/g, '').trim();
    const preview = lastMes.slice(0, 90) + (lastMes.length > 90 ? '…' : '');
    const date    = formatDate(char.date_last_chat);
    const count   = char.chat_size || 0;

    const tagHtml = (data.tags || []).map(tid => {
      const t = PRESET_TAGS.find(p => p.id === tid);
      return t
        ? `<span class="co-tag-badge" style="--co-tag-color:${t.color}">${t.label}</span>`
        : '';
    }).join('');

    return `
      <div class="co-card-overlay" data-chid="${chid}">
        <div class="co-meta-row">
          ${date  ? `<span class="co-meta-date">📅 ${escHtml(date)}</span>` : ''}
          ${count ? `<span class="co-meta-count">💬 ${count}</span>` : ''}
          <span class="co-meta-actions">
            <button class="co-pin-btn ${data.pinned ? 'active' : ''}" data-chid="${chid}"
              title="${data.pinned ? 'Открепить' : 'Закрепить'}">📌</button>
            <button class="co-note-btn" data-chid="${chid}" title="Заметка / Теги">📝</button>
          </span>
        </div>
        ${data.note ? `<div class="co-note-preview">${escHtml(data.note.slice(0, 110))}${data.note.length > 110 ? '…' : ''}</div>` : ''}
        ${tagHtml  ? `<div class="co-tags-row">${tagHtml}</div>` : ''}
        ${preview  ? `<div class="co-last-mes">${escHtml(preview)}</div>` : ''}
      </div>
    `;
  }

  function injectCard(el) {
    const chid = el.getAttribute('chid');
    if (!chid) return;

    // Remove stale overlay, rebuild fresh
    el.querySelector('.co-card-overlay')?.remove();

    const data = getCharData(chid);
    el.classList.toggle('co-pinned', !!data.pinned);

    const html = buildOverlayHtml(chid);
    if (html) el.insertAdjacentHTML('beforeend', html);
  }

  function injectAllCards() {
    document.querySelectorAll('.character_select[chid]').forEach(el => injectCard(el));
    sortPinnedToTop();
  }

  function refreshCard(chid) {
    const el = document.querySelector(`.character_select[chid="${chid}"]`);
    if (el) injectCard(el);
    sortPinnedToTop();
  }

  // ─── Note editor ──────────────────────────────────────────────────────────────

  function openNoteEditor(chid) {
    const { characters, Popup } = ctx();
    const char = characters?.[chid];
    if (!char) return;

    const data = getCharData(chid);

    const tagCheckboxes = PRESET_TAGS.map(t => `
      <label class="co-tag-ck" style="--co-tag-color:${t.color}">
        <input type="checkbox" class="co-tag-cb" value="${t.id}" ${(data.tags || []).includes(t.id) ? 'checked' : ''}>
        <span>${t.label}</span>
      </label>
    `).join('');

    // No await — popup timing fix
    Popup.show.text(`📝 ${escHtml(char.name)} — Заметка`,
      `<div style="color:#c8deff;font-size:13px">
        <div style="margin-bottom:5px;font-size:11px;opacity:.65;text-transform:uppercase;letter-spacing:.04em">Теги</div>
        <div class="co-tag-ck-grid">
          ${tagCheckboxes}
        </div>
        <div style="margin:12px 0 5px;font-size:11px;opacity:.65;text-transform:uppercase;letter-spacing:.04em">
          Заметка — что происходит, на чём остановились
        </div>
        <textarea id="co_note_ta" rows="5" placeholder="Например: Алиса нашла улику в подвале. Виктор всё ещё скрывает мотив. Пауза перед финальной сценой."
          style="width:100%;box-sizing:border-box;background:rgba(5,12,25,.9);border:1px solid rgba(100,160,255,.25);color:#c8deff;border-radius:8px;padding:9px 11px;font-size:12px;resize:vertical;font-family:inherit;line-height:1.55"
        >${escHtml(data.note || '')}</textarea>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button id="co_note_save"
            style="flex:1;padding:9px 12px;border-radius:8px;border:1px solid rgba(80,200,140,.5);background:rgba(60,180,120,.15);color:#70e8c0;cursor:pointer;font-size:13px;font-weight:700;min-width:120px">
            💾 Сохранить
          </button>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;padding:9px 12px;border-radius:8px;border:1px solid rgba(255,200,60,.25);background:rgba(255,200,60,.06)">
            <input type="checkbox" id="co_pin_cb" ${data.pinned ? 'checked' : ''}>
            <span style="color:rgba(255,200,60,.9);font-size:12px;font-weight:600">📌 Закреплён</span>
          </label>
        </div>
      </div>`
    );

    setTimeout(() => {
      document.getElementById('co_note_save')?.addEventListener('click', () => {
        const note   = (document.getElementById('co_note_ta')?.value || '').trim();
        const pinned = document.getElementById('co_pin_cb')?.checked ?? false;
        const tags   = [...document.querySelectorAll('.co-tag-cb:checked')].map(cb => cb.value);

        data.note   = note;
        data.pinned = pinned;
        data.tags   = tags;
        save();
        refreshCard(chid);
        applyFilters();
        toastr.success(`Заметка сохранена — ${char.name}`, '', { timeOut: 2500 });
      });
    }, 0);
  }

  // ─── Card button event delegation ────────────────────────────────────────────

  function wireCardEvents() {
    $(document)
      .off('click.co_pin')
      .on('click.co_pin', '.co-pin-btn', function (e) {
        e.stopPropagation();
        e.preventDefault();
        const chid   = this.getAttribute('data-chid');
        const data   = getCharData(chid);
        data.pinned  = !data.pinned;
        save();
        refreshCard(chid);
        applyFilters();
        toastr.info(data.pinned ? '📌 Закреплено' : 'Откреплено', '', { timeOut: 1500 });
      });

    $(document)
      .off('click.co_note')
      .on('click.co_note', '.co-note-btn', function (e) {
        e.stopPropagation();
        e.preventDefault();
        openNoteEditor(this.getAttribute('data-chid'));
      });
  }

  // ─── MutationObserver: reinject when list re-renders ─────────────────────────

  function attachObserver() {
    if (listObserver) return;
    const container = document.getElementById('rm_print_characters_block');
    if (!container) return;

    listObserver = new MutationObserver((mutations) => {
      let needsInject = false;
      for (const m of mutations) {
        if (m.addedNodes.length) { needsInject = true; break; }
      }
      if (needsInject) {
        // Defer to next tick so ST finishes rendering
        setTimeout(() => {
          injectAllCards();
          applyFilters();
        }, 0);
      }
    });

    listObserver.observe(container, { childList: true });
  }

  // ─── Settings panel ───────────────────────────────────────────────────────────

  async function mountSettingsUi() {
    if ($('#co_settings_block').length) return;
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) return;

    const s = getSettings();

    $(target).append(`
      <div id="co_settings_block">
        <div class="co-settings-title">
          <span>📂 Органайзер чатов</span>
          <button id="co_collapse_btn">${s.collapsed ? '▸' : '▾'}</button>
        </div>
        <div id="co_settings_body" ${s.collapsed ? 'style="display:none"' : ''}>
          <div class="co-settings-desc">
            Заметки, теги и 📌 прямо в списке чатов.<br>
            Поиск по именам, заметкам и последним сообщениям.
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
            <button class="menu_button" id="co_rescan_btn" style="font-size:11px;padding:5px 10px">
              🔄 Обновить список
            </button>
            <button class="menu_button" id="co_clear_all_btn"
              style="font-size:11px;padding:5px 10px;color:rgba(210,140,140,.8);border-color:rgba(200,80,80,.2)">
              🗑️ Сбросить все заметки
            </button>
          </div>
        </div>
      </div>
    `);

    $('#co_collapse_btn').on('click', () => {
      s.collapsed = !s.collapsed;
      $('#co_settings_body').toggle(!s.collapsed);
      $('#co_collapse_btn').text(s.collapsed ? '▸' : '▾');
      save();
    });

    $('#co_rescan_btn').on('click', () => {
      injectAllCards();
      applyFilters();
      toastr.success('Список обновлён', '', { timeOut: 1500 });
    });

    $('#co_clear_all_btn').on('click', async () => {
      const { Popup } = ctx();
      const ok = await Popup.show.confirm('Сбросить все заметки и теги?', 'Действие нельзя отменить.');
      if (!ok) return;
      getSettings().chars = {};
      save();
      injectAllCards();
      toastr.success('Все заметки удалены');
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────────

  function init() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async () => {
      ensureToolbar();
      injectAllCards();
      attachObserver();
      wireCardEvents();
      await mountSettingsUi();
    });

    // Re-inject after chat changes (ST may re-render the list)
    eventSource.on(event_types.CHAT_CHANGED, () => {
      setTimeout(() => {
        injectAllCards();
        applyFilters();
      }, 350);
    });

    // Re-inject toolbar if ST destroys it (e.g. on character list reload)
    setInterval(() => {
      if (!$('#co_toolbar').length && $('#rm_print_characters_block').length) {
        ensureToolbar();
      }
    }, 3000);
  }

  jQuery(() => {
    try { init(); console.log('[CO] v1.0.0 loaded'); }
    catch (e) { console.error('[CO] init failed', e); }
  });

})();
