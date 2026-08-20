/**
 * provider-catalog helpers: preset catalog merge, enabled semantics, base-URL
 * warnings, and model-list text helpers (used by the model-manager modal).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const moduleUrl = () => pathToFileURL(path.join(root, 'backend/static/js/modules/provider-catalog.js')).href;

let helpers;
test.before(async () => {
    helpers = await import(moduleUrl());
});

test('buildDisplayProviderRows renders the full catalog and overlays saved config', () => {
    const { buildDisplayProviderRows } = helpers;
    const rows = buildDisplayProviderRows([
        { id: 'deepseek', name: 'My DeepSeek', api_key: 'sk-1', base_url: 'https://api.deepseek.com/v1', model_id: 'deepseek-v4-flash' },
        { id: 'gateway', name: 'Gateway', api_key: '', base_url: 'https://gw.example.com/v1', model_id: 'gpt-4.1' },
    ]);

    // Catalog order is preserved; every catalog entry appears.
    const ids = rows.map(row => String(row.provider.id));
    assert.equal(ids[0], 'openai');
    assert.equal(ids[1], 'deepseek');
    assert.equal(ids[ids.length - 1], 'gateway');
    assert.ok(ids.length > 7, 'catalog plus extra custom rows');

    // No provider id appears twice — saved presets must not be re-pushed as customs.
    assert.equal(new Set(ids).size, ids.length, 'duplicate provider rows');

    const deepseek = rows.find(row => row.provider.id === 'deepseek');
    assert.equal(deepseek.isPreset, true);
    assert.equal(deepseek.provider.name, 'My DeepSeek', 'saved name overrides catalog label');
    assert.equal(deepseek.provider.enabled, undefined, 'saved provider without enabled flag stays enabled');
    assert.equal(deepseek.logo, '/static/assets/providers/deepseek.png');

    const openai = rows.find(row => row.provider.id === 'openai');
    assert.equal(openai.provider.enabled, false, 'untouched preset defaults to disabled');
    assert.equal(openai.provider.base_url, 'https://api.openai.com/v1', 'catalog default base url');
    assert.equal(openai.provider.model_id, 'gpt-5.6-sol', 'catalog default model');

    const gateway = rows.find(row => row.provider.id === 'gateway');
    assert.equal(gateway.isPreset, false, 'unrecognized id renders as custom row');
    assert.equal(gateway.logo, '/static/assets/providers/custom.png', 'custom fallback logo');
});

test('buildDisplayProviderRows merges saved catalog providers instead of duplicating them', () => {
    const { buildDisplayProviderRows } = helpers;
    // All 9 catalog providers saved → exactly 9 rows, all presets.
    const saved = [
        { id: 'openai', name: 'OpenAI', api_key: 'a', base_url: 'https://api.openai.com/v1', model_id: 'gpt-4.1' },
        { id: 'deepseek', name: 'DeepSeek', api_key: 'b', base_url: 'https://api.deepseek.com/v1', model_id: 'deepseek-v4-flash' },
        { id: 'anthropic', name: 'Anthropic', api_key: 'c', base_url: 'https://api.anthropic.com', model_id: 'claude-fable-5' },
        { id: 'openrouter', name: 'OpenRouter', api_key: 'd', base_url: 'https://openrouter.ai/api/v1', model_id: '~openai/gpt-latest' },
        { id: 'qwen', name: 'Qwen', api_key: 'e', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model_id: 'qwen3-max' },
        { id: 'kimi', name: 'Kimi', api_key: 'f', base_url: 'https://api.moonshot.ai/v1', model_id: 'kimi-k3' },
        { id: 'glm', name: 'GLM', api_key: 'g', base_url: 'https://open.bigmodel.cn/api/paas/v4', model_id: 'glm-5.2' },
        { id: 'meta', name: 'Meta', api_key: 'h', base_url: 'https://api.meta.ai/v1', model_id: 'muse-spark-1.2' },
        { id: 'hunyuan', name: 'Hunyuan', api_key: 'i', base_url: 'https://api.hunyuan.cloud.tencent.com/v1', model_id: 'hunyuan-turbos-latest' },
    ];
    const rows = buildDisplayProviderRows(saved);
    assert.equal(rows.length, 9);
    assert.ok(rows.every(row => row.isPreset), 'all saved catalog providers stay presets');
    assert.equal(rows.map(row => row.provider.id).join(','), 'openai,deepseek,anthropic,openrouter,qwen,kimi,glm,meta,hunyuan');
});

test('isProviderEnabled treats missing flag as enabled and only honors explicit false', () => {
    const { isProviderEnabled, getEnabledProviders } = helpers;
    assert.equal(isProviderEnabled({ enabled: true }), true);
    assert.equal(isProviderEnabled({ enabled: false }), false);
    assert.equal(isProviderEnabled({}), true);
    assert.equal(isProviderEnabled(null), true);
    assert.equal(isProviderEnabled(undefined), true);

    const enabled = getEnabledProviders([
        { id: 'a', enabled: true },
        { id: 'b', enabled: false },
        { id: 'c' },
    ]);
    assert.deepEqual(enabled.map(p => p.id), ['a', 'c']);
});

test('getBaseUrlWarning flags full endpoints but not roots', () => {
    const { getBaseUrlWarning } = helpers;
    assert.equal(getBaseUrlWarning('https://api.openai.com/v1'), '');
    assert.equal(getBaseUrlWarning('https://api.openai.com/v1/'), '');
    assert.equal(getBaseUrlWarning('https://api.deepseek.com/chat/completions').length > 0, true);
    assert.equal(getBaseUrlWarning('https://api.deepseek.com/v1/chat/completions').length > 0, true);
    assert.equal(getBaseUrlWarning('https://api.deepseek.com/models').length > 0, true);
});

test('model list text helpers parse, merge and serialize without duplicating', () => {
    const { parseModelListText, mergeModelOptions, serializeModels } = helpers;

    assert.deepEqual(parseModelListText('gpt-4.1, claude-fable-5\nqwen3-max;  deepseek-v4-flash'), [
        'gpt-4.1',
        'claude-fable-5',
        'qwen3-max',
        'deepseek-v4-flash',
    ]);
    assert.deepEqual(parseModelListText('  ,,  '), []);

    const merged = mergeModelOptions(
        [{ id: 'gpt-4.1', name: 'GPT 4.1' }],
        [{ id: 'gpt-4.1', name: 'Duplicate' }, { id: 'qwen3-max' }, { id: 'gpt-4.1-mini' }],
    );
    assert.deepEqual(merged, [
        { id: 'gpt-4.1', name: 'GPT 4.1' },
        { id: 'qwen3-max', name: 'qwen3-max' },
        { id: 'gpt-4.1-mini', name: 'gpt-4.1-mini' },
    ]);

    assert.equal(serializeModels(merged), 'gpt-4.1::GPT 4.1, qwen3-max, gpt-4.1-mini');
});
