import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let _activeDom = null;

afterEach(() => {
    try {
        _activeDom?.window?.close?.();
    } catch {
        // ignore
    }
    _activeDom = null;
});

function installBrowserGlobals() {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(`
        <!doctype html>
        <body>
            <select id="theme-select"><option value="light">Light</option></select>
            <select id="engine-select"><option value="google">Google</option></select>
            <input id="base-font-size-input" type="range" min="12" max="24" value="16">
            <span id="base-font-size-value">16px</span>
            <input id="live-artifacts-font-size-input" type="range" min="10" max="32" value="16">
            <span id="live-artifacts-font-size-value">16px</span>
            <input id="max-results-input" type="number">
            <input id="max-iterations-input" type="number">
            <input id="history-window-input" type="number">
            <input id="history-char-budget-input" type="number">
            <input id="assistant-turn-char-budget-input" type="number">
            <input id="interactive-search-input" type="checkbox" checked>
            <input id="max-concurrent-pages-input" type="number">
            <div id="provider-list-container"></div>
            <div id="workflow-step-models-container"></div>
            <div id="engine-check-results"></div>
            <span id="provider-count-label"></span>
        </body>
    `, { url: 'http://localhost/' });

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.HTMLElement = dom.window.HTMLElement;
    Object.defineProperty(globalThis, 'navigator', {
        value: dom.window.navigator,
        configurable: true,
    });
    _activeDom = dom;
    window.markdownit = () => ({
        render: value => String(value || ''),
        utils: { escapeHtml: value => String(value || '') },
    });
    window.DOMPurify = { sanitize: value => String(value || '') };
    window.hljs = { getLanguage: () => false };
    window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
}

test('provider id rename preserves workflow step model after transient empty input', async () => {
    installBrowserGlobals();
    const { __settingsModalTestHooks } = await import('../../backend/static/js/modules/settings-modal.js?test=provider-rename');
    const providers = [
        {
            id: 'openai',
            name: 'OpenAI',
            api_key: 'ope****1234',
            base_url: 'https://api.openai.com/v1',
            model_id: 'gpt-4.1:GPT 4.1, gpt-4.1-mini',
        },
    ];

    __settingsModalTestHooks.renderProviderList(providers, 'openai');
    __settingsModalTestHooks.renderWorkflowStepModels(
        {
            analysis: { provider_id: '', model_id: '' },
            relevance: { provider_id: '', model_id: '' },
            interaction: { provider_id: '', model_id: '' },
            answer: { provider_id: 'openai', model_id: 'gpt-4.1' },
        },
        providers,
        'openai',
    );

    const idInput = document.querySelector('.provider-id-input');
    idInput.value = '';
    idInput.dispatchEvent(new Event('input', { bubbles: true }));

    assert.deepEqual(
        __settingsModalTestHooks.collectWorkflowStepModels().answer,
        { provider_id: 'openai', model_id: 'gpt-4.1' },
    );

    idInput.value = 'openai-renamed';
    idInput.dispatchEvent(new Event('input', { bubbles: true }));

    assert.deepEqual(
        __settingsModalTestHooks.collectWorkflowStepModels().answer,
        { provider_id: 'openai-renamed', model_id: 'gpt-4.1' },
    );
});

test('compact model display names do not become API model ids', async () => {
    installBrowserGlobals();
    const { __settingsModalTestHooks } = await import('../../backend/static/js/modules/settings-modal.js?test=model-alias');
    const providers = [
        {
            id: 'gateway',
            name: 'Gateway',
            api_key: 'sk-****24a8',
            base_url: 'https://gw2.oops.asia/v1',
            model_id: 'gpt-5.5',
        },
    ];

    __settingsModalTestHooks.renderProviderList(providers, 'gateway');

    // 'gateway' is not a catalog entry, so it renders as a generic custom row.
    const gatewayCard = () => document.querySelector('.provider-card[data-live-provider-id="gateway"]');
    const nameInput = gatewayCard().querySelector('.model-name-input');
    nameInput.value = '5.5';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));

    const collected = __settingsModalTestHooks.collectProvidersForm();
    const gateway = collected.find(p => p.id === 'gateway');
    assert.equal(gateway.model_id, 'gpt-5.5::5.5');

    __settingsModalTestHooks.renderProviderList(
        [
            {
                ...providers[0],
                model_id: 'gpt-5.5:5.5, qwen2.5:7b::Qwen 7B',
            },
        ],
        'gateway',
    );

    const rows = Array.from(gatewayCard().querySelectorAll('.model-row'));
    assert.equal(rows[0].querySelector('.model-id-input').value, 'gpt-5.5');
    assert.equal(rows[0].querySelector('.model-name-input').value, '5.5');
    assert.equal(rows[1].querySelector('.model-id-input').value, 'qwen2.5:7b');
    assert.equal(rows[1].querySelector('.model-name-input').value, 'Qwen 7B');

    __settingsModalTestHooks.renderProviderList(
        [
            {
                ...providers[0],
                model_id: 'foo::, org/foo::',
            },
        ],
        'gateway',
    );

    const fallbackRows = Array.from(gatewayCard().querySelectorAll('.model-row'));
    assert.equal(fallbackRows[0].querySelector('.model-id-input').value, 'foo::');
    assert.equal(fallbackRows[0].querySelector('.model-name-input').value, '');
    assert.equal(fallbackRows[1].querySelector('.model-id-input').value, 'org/foo::');
    assert.equal(fallbackRows[1].querySelector('.model-name-input').value, '');
});

test('shared provider model parser preserves compact ids and display aliases', async () => {
    const {
        getModelDisplayName,
        getSupportedModelItems,
        isUnsupportedGemini25Model,
        splitModelItem,
    } = await import('../../backend/static/js/modules/provider-models.js?test=shared-parser');

    assert.deepEqual(splitModelItem('gpt-5.5::5.5'), {
        modelId: 'gpt-5.5',
        displayName: '5.5',
    });
    assert.deepEqual(splitModelItem('qwen2.5:7b::Qwen 7B'), {
        modelId: 'qwen2.5:7b',
        displayName: 'Qwen 7B',
    });
    assert.deepEqual(splitModelItem('qwen2.5:7b'), {
        modelId: 'qwen2.5:7b',
        displayName: 'qwen2.5:7b',
    });
    assert.equal(getModelDisplayName('org/model::Friendly'), 'Friendly');
    assert.equal(isUnsupportedGemini25Model('Gemini 2.5 Flash Lite'), true);
    assert.deepEqual(
        getSupportedModelItems('gemini-2.5-pro, gpt-4.1::GPT 4.1, qwen2.5:7b'),
        ['gpt-4.1::GPT 4.1', 'qwen2.5:7b'],
    );
});

test('provider rendering tolerates non-string settings values and escapes markup', async () => {
    installBrowserGlobals();
    const { __settingsModalTestHooks } = await import('../../backend/static/js/modules/settings-modal.js?test=provider-normalize');

    assert.doesNotThrow(() => {
        __settingsModalTestHooks.renderProviderList(
            [
                {
                    id: 7,
                    name: '<img src=x onerror=alert(1)>Gateway',
                    api_key: 12345,
                    base_url: '<script>alert(1)</script>',
                    model_id: 'gpt-5.5::<b>Alias</b>',
                },
            ],
            7,
        );
    });

    const card = document.querySelector('.provider-card[data-live-provider-id="7"]');
    assert.ok(card);
    assert.equal(card.querySelector('.provider-id-input').value, '7');
    assert.equal(card.querySelector('.provider-card-name').textContent, '<img src=x onerror=alert(1)>Gateway');
    assert.equal(card.querySelector('.provider-base-url-input').value, '<script>alert(1)</script>');
    assert.equal(card.querySelector('.model-id-input').value, 'gpt-5.5');
    assert.equal(card.querySelector('.model-name-input').value, '<b>Alias</b>');
    // Untrusted markup must be rendered as text — the only <img> is the provider logo.
    assert.equal(card.querySelectorAll('script').length, 0);
    assert.equal(card.querySelectorAll('b').length, 0);
    assert.equal(card.querySelectorAll('img').length, 1);
});

test('engine check results render untrusted response fields as text', async () => {
    installBrowserGlobals();
    const { __settingsModalTestHooks } = await import('../../backend/static/js/modules/settings-modal.js?test=engine-results');

    __settingsModalTestHooks.renderEngineCheckResults({
        query: '<img src=x onerror=alert(1)>',
        results: [
            {
                engine: '<svg onload=alert(1)>',
                available: false,
                error: '<script>alert(1)</script>',
            },
            {
                engine: 'google',
                available: true,
                result_count: 'not-a-number',
            },
        ],
    });

    const resultsEl = document.getElementById('engine-check-results');

    assert.equal(resultsEl.querySelector('.engine-check-query').textContent, '测试词：<img src=x onerror=alert(1)>');
    assert.equal(resultsEl.querySelector('.engine-check-name').textContent, '<svg onload=alert(1)>');
    assert.equal(resultsEl.querySelector('.engine-check-detail').textContent, '不可用 · <script>alert(1)</script>');
    assert.equal(resultsEl.querySelectorAll('script, img, svg').length, 0);
    assert.equal(
        Array.from(resultsEl.querySelectorAll('.engine-check-detail'))[1].textContent,
        '可用 · 0 个结果',
    );
});

test('settings form clamps numeric fields before saving', async () => {
    installBrowserGlobals();
    const { __settingsModalTestHooks } = await import('../../backend/static/js/modules/settings-modal.js?test=numeric-clamp');

    __settingsModalTestHooks.renderProviderList([
        {
            id: 'deepseek',
            name: 'DeepSeek',
            api_key: 'secret',
            base_url: 'https://api.deepseek.com/v1',
            model_id: 'deepseek-chat',
        },
    ], 'deepseek');

    document.getElementById('max-results-input').value = '500';
    document.getElementById('max-iterations-input').value = '-2';
    document.getElementById('max-concurrent-pages-input').value = '20.8';
    document.getElementById('base-font-size-input').value = '99';
    document.getElementById('live-artifacts-font-size-input').value = '2';

    const settings = __settingsModalTestHooks.collectSettingsForm();

    assert.equal(settings.max_results, 50);
    assert.equal(settings.max_iterations, 1);
    assert.equal(settings.base_font_size, 24);
    assert.equal(settings.live_artifacts_font_size, 10);
    assert.equal(__settingsModalTestHooks.normalizeNumberSetting('not-a-number', 5, 1, 10), 5);
});

test('settings form coerces string boolean toggles when filling form', async () => {
    installBrowserGlobals();
    const { __settingsModalTestHooks } = await import('../../backend/static/js/modules/settings-modal.js?test=boolean-coerce');
    const checkbox = document.getElementById('interactive-search-input');

    __settingsModalTestHooks.fillSettingsForm({
        theme: 'light',
        search_engine: 'google',
        interactive_search: 'false',
        providers: [],
        workflow_step_models: {},
    });
    assert.equal(checkbox.checked, false);

    __settingsModalTestHooks.fillSettingsForm({
        theme: 'light',
        search_engine: 'google',
        interactive_search: 'true',
        providers: [],
        workflow_step_models: {},
    });
    assert.equal(checkbox.checked, true);
});

test('enable toggle reflects in collected providers, disables default radio, updates badge', async () => {
    installBrowserGlobals();
    const { __settingsModalTestHooks } = await import('../../backend/static/js/modules/settings-modal.js?test=enabled-toggle');
    __settingsModalTestHooks.renderProviderList([
        {
            id: 'deepseek',
            name: 'DeepSeek',
            api_key: 'sk-test',
            base_url: 'https://api.deepseek.com/v1',
            model_id: 'deepseek-v4-flash',
        },
    ], 'deepseek');

    const card = document.querySelector('.provider-card[data-live-provider-id="deepseek"]');
    const enableInput = card.querySelector('.provider-enable-input');
    const radio = card.querySelector('input[name="default-provider-radio"]');
    assert.equal(enableInput.checked, true);
    assert.equal(radio.disabled, false);
    assert.equal(card.querySelector('.provider-status-badge').dataset.state, 'ready');

    // Toggle off → enabled:false collected, radio disabled, badge hidden.
    enableInput.checked = false;
    enableInput.dispatchEvent(new Event('change', { bubbles: true }));
    const disabled = __settingsModalTestHooks.collectProvidersForm().find(p => p.id === 'deepseek');
    assert.equal(disabled.enabled, false);
    assert.equal(radio.disabled, true);
    assert.equal(card.querySelector('.provider-status-badge').hidden, true);

    // Toggle back on → enabled:true, ready badge.
    enableInput.checked = true;
    enableInput.dispatchEvent(new Event('change', { bubbles: true }));
    const reEnabled = __settingsModalTestHooks.collectProvidersForm().find(p => p.id === 'deepseek');
    assert.equal(reEnabled.enabled, true);
    assert.equal(card.querySelector('.provider-status-badge').dataset.state, 'ready');
});

test('validateSettingsForm requires an enabled provider and an enabled default', async () => {
    installBrowserGlobals();
    const { __settingsModalTestHooks } = await import('../../backend/static/js/modules/settings-modal.js?test=validate-enabled');
    const base = (enabled) => ({ id: 'deepseek', name: 'DeepSeek', api_key: '', base_url: 'https://api.deepseek.com/v1', model_id: 'deepseek-v4-flash', enabled });

    assert.equal(
        __settingsModalTestHooks.validateSettingsForm({
            providers: [base(false), { ...base(true), id: 'openai' }],
            default_provider_id: 'openai',
        }).ok,
        true,
    );

    // All providers disabled → reject.
    assert.equal(
        __settingsModalTestHooks.validateSettingsForm({
            providers: [base(false)],
            default_provider_id: 'deepseek',
        }).ok,
        false,
    );

    // Default provider disabled while another is enabled → reject.
    assert.equal(
        __settingsModalTestHooks.validateSettingsForm({
            providers: [base(false), { ...base(true), id: 'openai' }],
            default_provider_id: 'deepseek',
        }).ok,
        false,
    );
});

test('model manager modal batch paste adds deduped models back to the provider card', async () => {
    installBrowserGlobals();
    const modal = document.createElement('div');
    modal.id = 'model-manager-modal';
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="model-manager-header">
                <h2 id="model-manager-title">管理模型</h2>
                <button type="button" class="model-manager-close-btn close-btn"></button>
            </div>
            <div class="model-manager-body">
                <section class="model-manager-current">
                    <span class="model-manager-count" id="model-manager-count">0</span>
                    <input type="search" id="model-manager-search">
                    <div class="model-manager-list" id="model-manager-list"></div>
                </section>
                <section class="model-manager-import">
                    <textarea id="model-manager-batch-input"></textarea>
                    <button type="button" id="model-manager-add-batch-btn"></button>
                    <p id="model-manager-batch-message" hidden></p>
                </section>
            </div>
        </div>`;
    document.body.appendChild(modal);

    const { __settingsModalTestHooks } = await import('../../backend/static/js/modules/settings-modal.js?test=manager-modal');
    __settingsModalTestHooks.renderProviderList([
        {
            id: 'deepseek',
            name: 'DeepSeek',
            api_key: 'sk',
            base_url: 'https://api.deepseek.com/v1',
            model_id: 'deepseek-v4-flash',
        },
    ], 'deepseek');
    const card = document.querySelector('.provider-card[data-live-provider-id="deepseek"]');
    const hiddenInput = card.querySelector('.provider-model-input');

    __settingsModalTestHooks.openModelManagerForCard(card);
    assert.equal(modal.classList.contains('active'), true);

    document.getElementById('model-manager-batch-input').value = 'qwen3-max, gpt-4.1\nclaude-fable-5, qwen3-max';
    document.getElementById('model-manager-add-batch-btn').click();

    const collected = hiddenInput.value.split(',').map(s => s.trim());
    assert.deepEqual(collected.slice().sort(), ['claude-fable-5', 'deepseek-v4-flash', 'gpt-4.1', 'qwen3-max']);
    assert.equal(new Set(collected).size, collected.length, 'duplicates must be deduped');
    assert.equal(document.getElementById('model-manager-batch-message').hidden, false);

    // Pasting only existing models adds nothing new.
    document.getElementById('model-manager-batch-input').value = 'qwen3-max';
    document.getElementById('model-manager-add-batch-btn').click();
    assert.equal(hiddenInput.value.split(',').map(s => s.trim()).length, 4);
});
