// ===========================================================================
// i18n core — leaf module (imports only locale dicts; no DOM/browser access
// that can throw at import time, so every jsdom test harness can import it).
//
// Storage: `justsearch_language` in localStorage ('zh' | 'en' | 'auto').
// Default is explicit 'zh' — NOT auto-derived — so jsdom tests (whose
// navigator.language is 'en-US') keep asserting Chinese output under default.
// zh is the source of truth; t() falls back zh → raw key.
// ===========================================================================

import { zh } from './locales/zh.js';
import { en } from './locales/en.js';

const LOCALES = { zh, en };
const STORAGE_KEY = 'justsearch_language';
const SUPPORTED = new Set(['zh', 'en', 'auto']);

const _escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

function _loadStored() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return SUPPORTED.has(stored) ? stored : 'zh';
    } catch (e) {
        return 'zh';
    }
}

function _normalize(pref) {
    return SUPPORTED.has(pref) ? pref : 'zh';
}

function _resolve(pref) {
    if (pref === 'en') return 'en';
    if (pref === 'zh') return 'zh';
    // 'auto' → follow the browser/OS language.
    try {
        return String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
    } catch (e) {
        return 'zh';
    }
}

let language = _loadStored();   // stored preference
let resolved = _resolve(language); // resolved active locale

function _lookup(key) {
    if (Object.prototype.hasOwnProperty.call(LOCALES[resolved], key)) {
        return LOCALES[resolved][key];
    }
    if (Object.prototype.hasOwnProperty.call(LOCALES.zh, key)) {
        return LOCALES.zh[key];
    }
    if (typeof console !== 'undefined' && console.warn) {
        console.warn('[i18n] missing key:', key);
    }
    return key;
}

function _interpolate(str, params) {
    if (!params) return str;
    return str.replace(/\{(\w+)\}/g, (m, k) =>
        (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m));
}

function _applyHtmlLang() {
    if (typeof document === 'undefined' || !document.documentElement) return;
    document.documentElement.lang = resolved === 'zh' ? 'zh-CN' : 'en';
}

// --- public API -----------------------------------------------------------

/** Stored preference: 'zh' | 'en' | 'auto'. */
export function getLanguage() { return language; }

/** Resolved active locale: 'zh' | 'en'. */
export function getEffectiveLanguage() { return resolved; }

/** Initialize from a preference (or stored). Returns resolved locale. */
export function initI18n(pref) {
    language = _normalize(pref !== undefined ? pref : _loadStored());
    resolved = _resolve(language);
    _applyHtmlLang();
    return resolved;
}

/** Set + persist the preference. Returns the stored value. */
export function setLanguage(lang) {
    language = _normalize(lang);
    resolved = _resolve(language);
    try {
        localStorage.setItem(STORAGE_KEY, language);
    } catch (e) { /* storage unavailable — in-memory only */ }
    _applyHtmlLang();
    return language;
}

/**
 * Raw interpolation — for textContent / attributes / aria-labels /
 * showConfirm/showToast arguments.
 */
export function t(key, params) {
    return _interpolate(_lookup(key), params);
}

/**
 * HTML-safe interpolation — escapes every {param} value, for strings embedded
 * into innerHTML templates or interpolated with user-controlled data.
 */
export function tHtml(key, params) {
    const safe = params
        ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, _escapeHtml(v)]))
        : params;
    return _interpolate(_lookup(key), safe);
}

/**
 * Re-scan static [data-i18n*] nodes + <meta> + <html lang>. Safe: applies
 * textContent / setAttribute only, never innerHTML.
 */
export function applyI18n(root = document) {
    _applyHtmlLang();
    if (typeof root === 'undefined' || !root || !root.querySelectorAll) return;

    root.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
        el.title = t(el.getAttribute('data-i18n-title'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
        el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
    });
    root.querySelectorAll('[data-i18n-value]').forEach((el) => {
        el.value = t(el.getAttribute('data-i18n-value'));
    });
    root.querySelectorAll('[data-i18n-content]').forEach((el) => {
        el.content = t(el.getAttribute('data-i18n-content'));
    });
}
