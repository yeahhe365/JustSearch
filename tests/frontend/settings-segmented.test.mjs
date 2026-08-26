import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

const HARNESS_HTML = `<!doctype html><html><body>
    <div class="settings-segmented" id="theme-segmented" role="radiogroup" data-settings-key="theme" aria-label="主题">
        <button type="button" class="settings-segment" role="radio" aria-checked="true" data-value="light">浅色</button>
        <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="dark">深色</button>
        <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="graphite">中性灰</button>
        <button type="button" class="settings-segment" role="radio" aria-checked="false" data-value="auto">跟随系统</button>
    </div>
</body></html>`;

function install() {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(HARNESS_HTML, { url: 'http://localhost/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.CustomEvent = dom.window.CustomEvent;
    return dom;
}

function moduleUrl() {
    return pathToFileURL(path.join(root, 'backend/static/js/modules/settings-segmented.js')).href + `?t=${Date.now()}`;
}

const group = () => document.getElementById('theme-segmented');
const checked = () => group().querySelector('.settings-segment[aria-checked="true"]')?.dataset.value;

test('click activates segment and fires onChange', async () => {
    install();
    const seen = [];
    const { initSegmentedGroups } = await import(moduleUrl());
    initSegmentedGroups({ onChange: (e) => seen.push(e) });
    group().querySelector('[data-value="graphite"]').click();
    assert.equal(checked(), 'graphite');
    assert.deepEqual(seen, [{ key: 'theme', value: 'graphite' }]);
});

test('keyboard wraps and supports Home/End', async () => {
    install();
    const { initSegmentedGroups } = await import(moduleUrl());
    initSegmentedGroups({ onChange: () => {} });
    const last = group().querySelector('[data-value="auto"]');
    last.focus();
    last.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    assert.equal(checked(), 'light', 'ArrowRight wraps to first');
    group().querySelector('[data-value="dark"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    assert.equal(checked(), 'auto');
});

test('set/get are programmatic and silent', async () => {
    install();
    let fired = 0;
    group().addEventListener('segmentedchange', () => { fired += 1; });
    const { setSegmentedValue, getSegmentedValue } = await import(moduleUrl());
    assert.equal(getSegmentedValue('theme'), 'light');
    assert.equal(setSegmentedValue('theme', 'dark', { silent: true }), true);
    assert.equal(checked(), 'dark');
    assert.equal(fired, 0, 'silent set dispatches nothing');
    assert.equal(getSegmentedValue('theme'), 'dark');
    assert.equal(setSegmentedValue('theme', 'nope'), false, 'unknown value rejected');
});
