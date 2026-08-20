/**
 * JustSearch — Provider catalog & helpers (AMC-aligned provider settings).
 *
 * The API-settings tab renders a fixed catalog of common providers (logo +
 * enable toggle + status badge) instead of a blank form. Existing saved
 * providers merge into the matching catalog row; unrecognized ids render as
 * generic custom rows (custom.png logo).
 */
import { t } from './i18n.js?v=1';

export const PROVIDER_CATALOG = [
    {
        id: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-5.6-sol'],
        logo: '/static/assets/providers/openai.png',
    },
    {
        id: 'deepseek',
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        logo: '/static/assets/providers/deepseek.png',
    },
    {
        id: 'anthropic',
        label: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        models: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
        logo: '/static/assets/providers/anthropic.png',
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: ['~openai/gpt-latest'],
        logo: '/static/assets/providers/openrouter.png',
    },
    {
        id: 'qwen',
        label: '通义千问 Qwen',
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        models: ['qwen3.7-max', 'qwen3.7-plus'],
        logo: '/static/assets/providers/qwen.png',
    },
    {
        id: 'kimi',
        label: 'Kimi (Moonshot)',
        baseUrl: 'https://api.moonshot.ai/v1',
        models: ['kimi-k3'],
        logo: '/static/assets/providers/kimi.png',
    },
    {
        id: 'glm',
        label: 'GLM (智谱)',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        models: ['glm-5.2'],
        logo: '/static/assets/providers/glm.png',
    },
    {
        id: 'meta',
        label: 'Meta',
        baseUrl: 'https://api.meta.ai/v1',
        models: ['muse-spark-1.2', 'muse-spark-1.5', 'muse-spark-h3'],
        logo: '/static/assets/providers/meta.svg',
    },
    {
        id: 'hunyuan',
        label: '混元 Hunyuan',
        baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
        models: ['hunyuan-turbos-latest', 'hunyuan-turbos', 'hunyuan-large'],
        logo: '/static/assets/providers/hunyuan.svg',
    },
];

/** Fallback logo for providers that are not in the catalog. */
export const GENERIC_PROVIDER_LOGO = '/static/assets/providers/custom.png';

/** A provider without an explicit enabled flag is treated as enabled. */
export function isProviderEnabled(provider) {
    return (provider?.enabled ?? true) !== false;
}

export function getEnabledProviders(providers) {
    return (Array.isArray(providers) ? providers : []).filter(isProviderEnabled);
}

export function getProviderCatalogEntry(providerId) {
    return PROVIDER_CATALOG.find((entry) => entry.id === providerId) || null;
}

export function getProviderLogo(providerId) {
    const entry = getProviderCatalogEntry(providerId);
    return entry ? entry.logo : GENERIC_PROVIDER_LOGO;
}

/**
 * Build the display rows for the provider list: the full catalog (in order,
 * existing config merged in; untouched presets default to disabled) followed by
 * any saved provider whose id is not a catalog entry (generic custom row).
 * @returns {Array<{provider: object, isPreset: boolean, logo: string}>}
 */
export function buildDisplayProviderRows(savedProviders) {
    const saved = Array.isArray(savedProviders) ? savedProviders : [];
    const savedById = new Map();
    saved.forEach((provider) => {
        const id = String(provider?.id || '').trim();
        if (id) savedById.set(id, provider);
    });

    const rows = [];
    PROVIDER_CATALOG.forEach((entry) => {
        const existing = savedById.get(entry.id);
        if (existing) {
            rows.push({
                provider: {
                    ...existing,
                    id: entry.id,
                    name: String(existing.name || '').trim() || entry.label,
                    base_url: String(existing.base_url || '').trim() || entry.baseUrl,
                    model_id: String(existing.model_id || '').trim() || entry.models.join(', '),
                },
                isPreset: true,
                logo: entry.logo,
            });
        } else {
            rows.push({
                provider: {
                    id: entry.id,
                    name: entry.label,
                    api_key: '',
                    base_url: entry.baseUrl,
                    model_id: entry.models.join(', '),
                    enabled: false,
                },
                isPreset: true,
                logo: entry.logo,
            });
        }
        savedById.delete(entry.id);
    });

    // Any remaining saved providers (ids not consumed by a catalog entry)
    // render as generic custom rows.
    savedById.forEach((provider) => {
        const id = String(provider?.id || '').trim();
        if (!id) return;
        rows.push({ provider, isPreset: false, logo: GENERIC_PROVIDER_LOGO });
    });

    return rows;
}

/**
 * Warn when the base URL already includes a full endpoint so users don't
 * double-path it. Mirrors AMC's getOpenAICompatibleBaseUrlWarning.
 * @returns {string} '' when the URL looks like a root, else a hint.
 */
export function getBaseUrlWarning(baseUrl) {
    const url = String(baseUrl || '').trim().replace(/\/+$/, '');
    const lower = url.toLowerCase();
    if (lower.endsWith('/chat/completions')) {
        return t('provider.baseUrlChatCompletionsHint');
    }
    if (lower.endsWith('/models')) {
        return t('provider.baseUrlModelsHint');
    }
    return '';
}

/** Split pasted model ids on whitespace / commas / semicolons. */
export function parseModelListText(text) {
    return String(text || '')
        .split(/[\s,，;；]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

/** Join {id, name} rows back into the stored "id::name, id" format. */
export function serializeModels(models) {
    return (Array.isArray(models) ? models : [])
        .map((model) => {
            const id = String(model?.id ?? '').trim();
            const name = String(model?.name ?? '').trim();
            if (!id) return '';
            return name && name !== id ? `${id}::${name}` : id;
        })
        .filter(Boolean)
        .join(', ');
}

/** Merge incoming model ids into current rows, deduped by id (keeps first name). */
export function mergeModelOptions(current, incoming) {
    const seen = new Set();
    const result = [];
    (Array.isArray(current) ? current : []).forEach((model) => {
        const id = String(model?.id ?? '').trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        result.push({ id, name: String(model?.name ?? '').trim() });
    });
    (Array.isArray(incoming) ? incoming : []).forEach((model) => {
        const id = String(model?.id ?? '').trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        result.push({ id, name: String(model?.name ?? '').trim() || id });
    });
    return result;
}
