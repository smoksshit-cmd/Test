/**
 * fmt-theme.js — адаптация FMT под тему SillyTavern  v2.0
 *
 * Приоритет источников:
 *   1. CSS-переменные SillyTavern (--SmartTheme*, --main-text-color и др.)
 *   2. Computed-стили реальных DOM-элементов (fallback)
 *   3. Хардкод тёмной темы (последний рубеж)
 *
 * Вызывать: fmtApplyTheme() после создания дровера.
 * Событие:  document.addEventListener('fmt:theme-apply', handler)
 */

(function () {
  'use strict';

  /* ─── Утилиты ────────────────────────────────────────────────── */

  /** Читает CSS-переменную с :root или указанного элемента */
  function cssVar(name, el) {
    const val = getComputedStyle(el || document.documentElement)
      .getPropertyValue(name).trim();
    return val || null;
  }

  /** Парсит любой rgb/rgba/hex в { r, g, b, a } или null */
  function parseColor(str) {
    if (!str) return null;
    str = str.trim();

    // rgb / rgba
    const rm = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
    if (rm) return { r: +rm[1], g: +rm[2], b: +rm[3], a: rm[4] !== undefined ? +rm[4] : 1 };

    // hex 3/4/6/8
    const hex = str.replace('#', '');
    if (/^[0-9a-f]{3}$/i.test(hex)) {
      return { r: parseInt(hex[0]+hex[0], 16), g: parseInt(hex[1]+hex[1], 16), b: parseInt(hex[2]+hex[2], 16), a: 1 };
    }
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      return { r: parseInt(hex.slice(0,2),16), g: parseInt(hex.slice(2,4),16), b: parseInt(hex.slice(4,6),16), a: 1 };
    }
    if (/^[0-9a-f]{8}$/i.test(hex)) {
      return { r: parseInt(hex.slice(0,2),16), g: parseInt(hex.slice(2,4),16), b: parseInt(hex.slice(4,6),16), a: parseInt(hex.slice(6,8),16)/255 };
    }

    // hsl / hsla — конвертируем
    const hm = str.match(/hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%(?:\s*,\s*([\d.]+))?\s*\)/);
    if (hm) {
      const h = +hm[1]/360, s = +hm[2]/100, l = +hm[3]/100;
      const q = l < 0.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
      const hue2 = (t) => {
        if (t<0) t+=1; if (t>1) t-=1;
        if (t<1/6) return p+(q-p)*6*t;
        if (t<1/2) return q;
        if (t<2/3) return p+(q-p)*(2/3-t)*6;
        return p;
      };
      return s === 0
        ? { r: Math.round(l*255), g: Math.round(l*255), b: Math.round(l*255), a: hm[4]!==undefined?+hm[4]:1 }
        : { r: Math.round(hue2(h+1/3)*255), g: Math.round(hue2(h)*255), b: Math.round(hue2(h-1/3)*255), a: hm[4]!==undefined?+hm[4]:1 };
    }

    return null;
  }

  function toRgb(c) {
    if (!c) return null;
    const p = parseColor(c);
    if (!p) return null;
    return `rgb(${p.r},${p.g},${p.b})`;
  }

  function toRgba(c, a) {
    if (!c) return null;
    const p = parseColor(c);
    if (!p) return null;
    return `rgba(${p.r},${p.g},${p.b},${a})`;
  }

  /** Воспринимаемая яркость 0-1 */
  function luma(c) {
    const p = parseColor(c);
    if (!p) return 0.5;
    return (0.299*p.r + 0.587*p.g + 0.114*p.b) / 255;
  }

  /** Смешать base с overlay с весом t (0=base, 1=overlay), оба — любой CSS-цвет */
  function mix(base, overlay, t) {
    const b = parseColor(base), o = parseColor(overlay);
    if (!b || !o) return base;
    return `rgb(${Math.round(b.r*(1-t)+o.r*t)},${Math.round(b.g*(1-t)+o.g*t)},${Math.round(b.b*(1-t)+o.b*t)})`;
  }

  /** Lighten (t>0) или darken (t<0) цвет */
  function shift(c, t) {
    return t >= 0 ? mix(c, '#ffffff', t) : mix(c, '#000000', -t);
  }

  /** Найти ближайший непрозрачный bg, поднимаясь по дереву */
  function getBg(el, depth=8) {
    while (el && depth-->0) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
      el = el.parentElement;
    }
    return null;
  }

  /** Получить вычисленный цвет свойства с fallback */
  function gc(selector, prop) {
    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!el) return null;
    return getComputedStyle(el)[prop] || null;
  }

  /* ─── Чтение переменных SillyTavern ─────────────────────────── */

  /**
   * Возвращает объект со всеми цветами темы ST.
   * Пробует CSS-переменные разных версий ST, затем DOM.
   */
  function readSTTheme() {
    const root = document.documentElement;
    const cs   = getComputedStyle(root);

    const v = (name) => cs.getPropertyValue(name).trim() || null;

    /* ── Фон тела / чата ── */
    const bodyBg =
      v('--SmartThemeBodyColor') ||          // тема Smart Theme / Custom Theme
      v('--body-bg') ||
      v('--background-color') ||
      getBg(document.getElementById('chat')) ||
      getBg(document.body) ||
      'rgb(24,33,46)';

    /* ── Фон сообщения бота ── */
    const mesBg =
      v('--SmartThemeBotMesColor') ||
      v('--mes-bg') ||
      v('--chat-message-bg') ||
      getBg(document.querySelector('.mes:not(.last_mes)')) ||
      getBg(document.querySelector('.last_mes')) ||
      bodyBg;

    /* ── Основной цвет текста ── */
    const textColor =
      v('--SmartThemeFontColor') ||
      v('--main-text-color') ||
      v('--text-color') ||
      gc('.mes_text', 'color') ||
      gc('.mes',      'color') ||
      gc('body',      'color') ||
      'rgb(200,222,255)';

    /* ── Акцент / ссылки ── */
    const accentColor =
      v('--SmartThemeEmColor') ||
      v('--SmartThemeBlurTintColor') ||      // некоторые темы кладут акцент сюда
      v('--accent-color') ||
      v('--link-color') ||
      (() => {
        // пробуем живые элементы
        for (const sel of ['.menu_button', 'a', 'h2', '.nav-item.active', '.btn-primary', '#send_but']) {
          const c = gc(sel, 'color');
          if (c && luma(c) > 0.3 && c !== textColor) return c;
        }
        return null;
      })() ||
      shift(textColor, 0.15);

    /* ── Цвет границы ── */
    const borderColor =
      v('--SmartThemeBorderColor') ||
      v('--border-color') ||
      (() => {
        for (const sel of ['.mes', '#sheld', '#chat', '#send_form']) {
          const c = gc(sel, 'borderColor') || gc(sel, 'borderTopColor');
          if (c && c !== 'rgba(0, 0, 0, 0)') return c;
        }
        return null;
      })() ||
      toRgba(textColor, 0.2);

    /* ── Blur / overlay ── */
    const blurTint =
      v('--SmartThemeBlurStrength') ? null : // если есть blur strength — это другое
      v('--SmartThemeBlurTintColor') ||
      v('--overlay-bg') ||
      null;

    /* ── Фон инпута ── */
    const inputBg =
      v('--SmartThemeInputBgColor') ||
      v('--input-bg') ||
      getBg(document.getElementById('send_textarea')) ||
      mesBg;

    /* ── Цвет шапки / nav ── */
    const headerBg =
      v('--SmartThemeHeaderBgColor') ||
      v('--header-bg') ||
      getBg(document.getElementById('top-bar')) ||
      getBg(document.querySelector('.nav-bar')) ||
      mix(bodyBg, '#000000', 0.15);

    return { bodyBg, mesBg, textColor, accentColor, borderColor, blurTint, inputBg, headerBg };
  }

  /* ─── Вычисление переменных FMT ──────────────────────────────── */

  function computeFmtVars(st) {
    const { bodyBg, mesBg, textColor, accentColor, borderColor, blurTint, headerBg } = st;
    const isDark = luma(bodyBg) < 0.5;

    /* Фоны */
    const fmtBg      = bodyBg;
    const fmtBgDeep  = isDark ? mix(bodyBg, '#000000', 0.22) : mix(bodyBg, '#000000', 0.06);
    const fmtBgMid   = toRgba(isDark ? '#ffffff' : '#000000', isDark ? 0.04 : 0.025);
    const fmtBgHi    = toRgba(accentColor, isDark ? 0.09 : 0.07);

    /* Граница */
    const parsedBorder = parseColor(borderColor);
    const fmtBorder = parsedBorder && parsedBorder.a > 0.05
      ? `rgba(${parsedBorder.r},${parsedBorder.g},${parsedBorder.b},${Math.min(parsedBorder.a, 0.35)})`
      : toRgba(accentColor, 0.22);

    /* Текст */
    const fmtText    = textColor;
    const parsedText = parseColor(textColor) || { r:180, g:200, b:240 };
    const fmtTextDim = `rgba(${parsedText.r},${parsedText.g},${parsedText.b},0.55)`;

    /* Акцент */
    const fmtAccent = accentColor;

    /* Шапка дровера */
    const fmtHeaderBg = isDark
      ? mix(fmtBg, accentColor, 0.06)
      : mix(fmtBg, accentColor, 0.09);

    /* Overlay-тинт */
    const fmtBlurTint = blurTint
      ? toRgba(blurTint, isDark ? 0.65 : 0.45)
      : (isDark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.28)');

    return {
      '--fmt-bg':         fmtBg,
      '--fmt-bg-deep':    fmtBgDeep,
      '--fmt-bg-mid':     fmtBgMid,
      '--fmt-bg-hi':      fmtBgHi,
      '--fmt-border':     fmtBorder,
      '--fmt-text':       fmtText,
      '--fmt-text-dim':   fmtTextDim,
      '--fmt-accent':     fmtAccent,
      '--fmt-header-bg':  fmtHeaderBg,
      '--fmt-blur-tint':  fmtBlurTint,
      '--fmt-is-dark':    isDark ? '1' : '0',
    };
  }

  /* ─── Применение переменных ──────────────────────────────────── */

  function applyVars(el, vars) {
    if (!el) return;
    for (const [k, v] of Object.entries(vars)) {
      if (v !== null && v !== undefined) el.style.setProperty(k, v);
    }
  }

  /* ─── Публичная функция ──────────────────────────────────────── */

  window.fmtApplyTheme = function () {
    const st   = readSTTheme();
    const vars = computeFmtVars(st);
    const isDark = vars['--fmt-is-dark'] === '1';

    /* Применяем на все FMT-элементы */
    const targets = [
      document.getElementById('fmt_drawer'),
      document.getElementById('fmt_overlay'),
      document.getElementById('fmt_fab'),
    ].filter(Boolean);

    targets.forEach(el => applyVars(el, vars));

    /* Дополнительно для FAB — чтобы кнопка была видна */
    const fab = document.getElementById('fmt_fab');
    if (fab) {
      /* Если акцент слишком близок к фону — слегка усиливаем */
      const accentL = luma(vars['--fmt-accent']);
      const bgL     = luma(vars['--fmt-bg']);
      if (Math.abs(accentL - bgL) < 0.1) {
        const boosted = isDark ? shift(vars['--fmt-accent'], 0.25) : shift(vars['--fmt-accent'], -0.25);
        fab.style.setProperty('--fmt-accent', boosted);
        document.getElementById('fmt_drawer')?.style.setProperty('--fmt-accent', boosted);
      }
    }

    /* Уведомляем другие модули */
    document.dispatchEvent(new CustomEvent('fmt:theme-apply', {
      detail: {
        isDark,
        accent: vars['--fmt-accent'],
        bg:     vars['--fmt-bg'],
        text:   vars['--fmt-text'],
        vars,
      },
    }));
  };

  /* ─── Авто-перезапуск при смене темы ─────────────────────────── */

  let _themeDebounce = null;
  const reapply = () => {
    clearTimeout(_themeDebounce);
    _themeDebounce = setTimeout(() => window.fmtApplyTheme?.(), 120);
  };

  /* Смена класса / атрибута на body и html */
  new MutationObserver(reapply).observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'],
  });
  new MutationObserver(reapply).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'],
  });

  /* ST меняет CSS-переменные напрямую на :root — ловим через style-мутации */
  new MutationObserver(reapply).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  /* Перечитываем при открытии дровера */
  document.addEventListener('fmt:panel-open', reapply);

  /* Первый прогон — ждём чуть больше, чтобы ST успел применить тему */
  document.addEventListener('DOMContentLoaded', () => setTimeout(reapply, 200));
  if (document.readyState !== 'loading') setTimeout(reapply, 200);

})();
