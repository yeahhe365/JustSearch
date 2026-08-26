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
    <select id="engine-select" class="settings-select">
        <option value="google" selected>Google</option>
        <option value="bing">Bing</option>
    </select>
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
    return pathToFileURL(path.join(root, 'backend/static/js/modules/settings-dropdown.js')).href + `?t=${Date.now()}`;
}

test('dropdown upgrades select: trigger label, option pick fires change', async () => {
    install();
    let changed = [];
    const sel = document.getElementById('engine-select');
    sel.addEventListener('change', () => changed.push(sel.value));
    const { initSettingsDropdowns } = await import(moduleUrl());
    initSettingsDropdowns(document);
    const trigger = document.querySelector('.settings-dd-trigger');
    assert.ok(trigger, 'trigger rendered');
    assert.equal(trigger.querySelector('.settings-dd-label').textContent, 'Google');
    assert.equal(getComputedStyle(sel).display, 'none', 'native select hidden');
    trigger.click();
    assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'panel opens');
    const opt = document.querySelector('.settings-dd-option[data-value="bing"]');
    opt.click();
    assert.equal(sel.value, 'bing', 'select value synced');
    assert.deepEqual(changed, ['bing'], 'change event fired once');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'panel closes after pick');
    assert.equal(trigger.querySelector('.settings-dd-label').textContent, 'Bing', 'label updated');
});

test('syncFromSelect picks up external value writes', async () => {
    install();
    const { initSettingsDropdowns, syncFromSelect } = await import(moduleUrl());
    initSettingsDropdowns(document);
    const sel = document.getElementById('engine-select');
    sel.value = 'bing';
    syncFromSelect(sel);
    assert.equal(document.querySelector('.settings-dd-label').textContent, 'Bing');
});
