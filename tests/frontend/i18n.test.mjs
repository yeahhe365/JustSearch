import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function installBrowserGlobals(html = '<!doctype html><html lang="zh-CN"><head></head><body></body></html>') {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(html, { url: 'http://localhost/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
        value: dom.window.navigator,
        configurable: true,
        writable: true,
    });
    globalThis.localStorage = dom.window.localStorage;
    return dom;
}

function moduleUrl() {
    const path = require.resolve('../../backend/static/js/modules/i18n.js');
    return `${path}?t=${Date.now()}`;
}

test('default language resolves to zh', async () => {
    installBrowserGlobals();
    const { getLanguage, getEffectiveLanguage, t } = await import(moduleUrl());
    assert.equal(getLanguage(), 'zh');
    assert.equal(getEffectiveLanguage(), 'zh');
    assert.equal(t('common.confirm'), '确认');
    assert.equal(t('sidebar.newChat'), '新对话');
});

test('setLanguage("en") updates output and <html lang>', async () => {
    const dom = installBrowserGlobals();
    const { setLanguage, getEffectiveLanguage, t, applyI18n } = await import(moduleUrl());
    setLanguage('en');
    assert.equal(getEffectiveLanguage(), 'en');
    assert.equal(document.documentElement.lang, 'en');
    assert.equal(t('common.confirm'), 'Confirm');

    // data-i18n scan applies English
    document.body.innerHTML = '<button data-i18n="sidebar.newChat">新对话</button>';
    applyI18n();
    assert.equal(document.querySelector('button').textContent, 'New chat');
    assert.equal(document.querySelector('button').textContent, t('sidebar.newChat'));
});

test('setLanguage persists to localStorage', async () => {
    installBrowserGlobals();
    const { setLanguage, getLanguage } = await import(moduleUrl());
    setLanguage('en');
    assert.equal(localStorage.getItem('justsearch_language'), 'en');
});

test('stored preference is honored at import', async () => {
    const dom = installBrowserGlobals();
    dom.window.localStorage.setItem('justsearch_language', 'en');
    // Re-import with a fresh query string so module state reloads.
    const { t } = await import(`${moduleUrl()}&x=2`);
    assert.equal(t('common.confirm'), 'Confirm');
});

test('fallback chain: active → zh → raw key', async () => {
    installBrowserGlobals();
    const { t, setLanguage } = await import(moduleUrl());
    // Unknown key in en falls back to zh
    setLanguage('en');
    assert.equal(t('common.confirm'), 'Confirm');
    // Totally unknown key returns the key itself (and warns)
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args);
    try {
        assert.equal(t('definitely.not.a.key'), 'definitely.not.a.key');
        assert.ok(warns.some((a) => a.some((x) => String(x).includes('definitely.not.a.key'))));
    } finally {
        console.warn = origWarn;
    }
});

test('interpolation replaces {param} tokens', async () => {
    installBrowserGlobals();
    const { t } = await import(moduleUrl());
    assert.equal(
        t('searchIntensity.hintCustom', { sources: 8, rounds: 3 }),
        '约 8 源 · 最多 3 轮'
    );
    assert.equal(
        t('settings.providerCount', { count: 2 }),
        '2 个连接'
    );
});

test('tHtml escapes params', async () => {
    installBrowserGlobals();
    const { tHtml } = await import(moduleUrl());
    assert.equal(
        tHtml('settings.confirmDeleteProvider', { name: '<script>alert(1)</script>' }),
        '确定删除 &lt;script&gt;alert(1)&lt;/script&gt; 吗？'
    );
    // t() does NOT escape
    const { t } = await import(`${moduleUrl()}&y=1`);
    assert.equal(
        t('settings.confirmDeleteProvider', { name: '<b>x</b>' }),
        '确定删除 <b>x</b> 吗？'
    );
});

test('initI18n("auto") follows navigator.language', async () => {
    const dom = installBrowserGlobals();
    dom.window.localStorage.removeItem('justsearch_language');
    Object.defineProperty(dom.window.navigator, 'language', {
        value: 'en-US',
        configurable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
        value: dom.window.navigator,
        configurable: true,
        writable: true,
    });
    const { initI18n, t } = await import(moduleUrl());
    initI18n('auto');
    assert.equal(document.documentElement.lang, 'en');
    assert.equal(t('common.confirm'), 'Confirm');

    Object.defineProperty(dom.window.navigator, 'language', {
        value: 'zh-CN',
        configurable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
        value: dom.window.navigator,
        configurable: true,
        writable: true,
    });
    initI18n('auto');
    assert.equal(document.documentElement.lang, 'zh-CN');
    assert.equal(t('common.confirm'), '确认');
});

test('applyI18n translates all data-i18n attribute variants', async () => {
    installBrowserGlobals(`
        <!doctype html>
        <html lang="zh-CN">
        <head><meta name="description" data-i18n-content="meta.description" content="x">
        </head>
        <body>
          <span data-i18n="sidebar.newChat">新对话</span>
          <input data-i18n-placeholder="inputArea.placeholder" placeholder="提出问题...">
          <button data-i18n-aria-label="sidebar.toggleTheme" aria-label="切换主题"></button>
          <div data-i18n-title="sidebar.collapse" title="收起侧栏"></div>
          <option data-i18n-value="settings.themeLight" value="light">浅色</option>
        </body></html>
    `);
    const { setLanguage, applyI18n } = await import(moduleUrl());
    setLanguage('en');
    applyI18n();

    assert.equal(document.querySelector('span').textContent, 'New chat');
    assert.equal(document.querySelector('input').placeholder, 'Ask anything...');
    assert.equal(document.querySelector('button').getAttribute('aria-label'), 'Toggle theme');
    assert.equal(document.querySelector('div').title, 'Collapse sidebar');
    assert.equal(document.querySelector('option').value, 'Light');
    const meta = document.querySelector('meta[name="description"]');
    assert.ok(meta.content.includes('AI-powered deep research'));
});

test('importing i18n.js never throws without localStorage/navigator globals', async () => {
    // Fresh module, no globals installed (or globals cleared).
    const fresh = `${moduleUrl()}&z=3`;
    try {
        localStorage.removeItem('justsearch_language');
    } catch (e) { /* no localStorage */ }
    const { t, getLanguage } = await import(fresh);
    assert.equal(getLanguage(), 'zh');
    assert.equal(t('common.confirm'), '确认');
});
