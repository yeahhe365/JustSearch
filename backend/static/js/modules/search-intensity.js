/**
 * 搜索强度档位：映射 max_results（广度）与 max_iterations（深度）。
 */

import { t } from './i18n.js?v=1';

export const INTENSITY_PRESETS = Object.freeze([
    {
        id: 'quick',
        labelKey: 'searchIntensity.quick',
        max_results: 8,
        max_iterations: 3,
        hintKey: 'searchIntensity.quickHint',
    },
    {
        id: 'balanced',
        labelKey: 'searchIntensity.balanced',
        max_results: 12,
        max_iterations: 5,
        hintKey: 'searchIntensity.balancedHint',
    },
    {
        id: 'deep',
        labelKey: 'searchIntensity.deep',
        max_results: 20,
        max_iterations: 8,
        hintKey: 'searchIntensity.deepHint',
    },
    {
        id: 'research',
        labelKey: 'searchIntensity.research',
        max_results: 30,
        max_iterations: 10,
        hintKey: 'searchIntensity.researchHint',
    },
]);

export function getIntensityPresetLabel(preset) {
    return preset ? t(preset.labelKey) : '';
}
export function getIntensityPresetHint(preset) {
    return preset ? t(preset.hintKey) : '';
}

const PRESET_BY_ID = Object.freeze(
    Object.fromEntries(INTENSITY_PRESETS.map((preset) => [preset.id, preset]))
);

export function clampMaxResults(value, fallback = 8) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(50, Math.trunc(parsed)));
}

export function clampMaxIterations(value, fallback = 3) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(10, Math.trunc(parsed)));
}

export function getIntensityPreset(id) {
    return PRESET_BY_ID[id] || null;
}

export function matchIntensityPreset(maxResults, maxIterations) {
    const results = clampMaxResults(maxResults, NaN);
    const iterations = clampMaxIterations(maxIterations, NaN);
    if (!Number.isFinite(results) || !Number.isFinite(iterations)) {
        return null;
    }
    return INTENSITY_PRESETS.find(
        (preset) => preset.max_results === results && preset.max_iterations === iterations
    ) || null;
}

export function resolveIntensityFromSettings(settings = {}) {
    const maxResults = clampMaxResults(settings.max_results, 12);
    const maxIterations = clampMaxIterations(settings.max_iterations, 5);
    const preset = matchIntensityPreset(maxResults, maxIterations);
    if (preset) {
        return {
            id: preset.id,
            label: getIntensityPresetLabel(preset),
            max_results: preset.max_results,
            max_iterations: preset.max_iterations,
            hint: getIntensityPresetHint(preset),
            isCustom: false,
        };
    }
    return {
        id: 'custom',
        label: t('searchIntensity.custom'),
        max_results: maxResults,
        max_iterations: maxIterations,
        hint: t('searchIntensity.hintCustom', { sources: maxResults, rounds: maxIterations }),
        isCustom: true,
    };
}

export function applyIntensityPresetToSettings(settings, presetId) {
    const preset = getIntensityPreset(presetId);
    if (!preset || !settings || typeof settings !== 'object') {
        return settings;
    }
    return {
        ...settings,
        max_results: preset.max_results,
        max_iterations: preset.max_iterations,
    };
}

/**
 * 根据当前 max_results / max_iterations 刷新 chip 选中态与提示文案。
 */
export function updateIntensityUI({
    maxResults,
    maxIterations,
    disabled = false,
    root = document,
} = {}) {
    const resolved = resolveIntensityFromSettings({
        max_results: maxResults,
        max_iterations: maxIterations,
    });
    const bar = root.getElementById?.('search-intensity-bar') || root.querySelector?.('#search-intensity-bar');
    if (!bar) return resolved;

    const hintEl = root.getElementById?.('search-intensity-hint') || bar.querySelector('#search-intensity-hint');
    const chips = Array.from(bar.querySelectorAll('.intensity-chip[data-intensity]'));
    const customChip = bar.querySelector('.intensity-chip[data-intensity="custom"]');

    if (customChip) {
        customChip.hidden = !resolved.isCustom;
        customChip.setAttribute('aria-hidden', resolved.isCustom ? 'false' : 'true');
    }

    chips.forEach((chip) => {
        const id = chip.getAttribute('data-intensity');
        const isActive = id === resolved.id;
        chip.classList.toggle('active', isActive);
        chip.setAttribute('aria-checked', isActive ? 'true' : 'false');
        chip.disabled = Boolean(disabled);
        chip.tabIndex = isActive ? 0 : -1;
    });

    if (hintEl) {
        hintEl.textContent = resolved.hint;
    }

    bar.classList.toggle('is-disabled', Boolean(disabled));
    bar.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    // 使用 data-active-intensity，避免与 chip 的 data-intensity 在 querySelector 时冲突
    bar.dataset.activeIntensity = resolved.id;

    return resolved;
}
