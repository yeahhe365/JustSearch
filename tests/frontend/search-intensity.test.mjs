import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    INTENSITY_PRESETS,
    applyIntensityPresetToSettings,
    clampMaxIterations,
    clampMaxResults,
    matchIntensityPreset,
    resolveIntensityFromSettings,
    updateIntensityUI,
} from '../../backend/static/js/modules/search-intensity.js';

test('presets cover four intensity tiers with bounded limits', () => {
    assert.equal(INTENSITY_PRESETS.length, 4);
    for (const preset of INTENSITY_PRESETS) {
        assert.ok(preset.max_results >= 1 && preset.max_results <= 50);
        assert.ok(preset.max_iterations >= 1 && preset.max_iterations <= 10);
    }
});

test('matchIntensityPreset returns exact preset or null', () => {
    assert.equal(matchIntensityPreset(8, 3)?.id, 'quick');
    assert.equal(matchIntensityPreset(20, 8)?.id, 'deep');
    assert.equal(matchIntensityPreset(30, 10)?.id, 'research');
    assert.equal(matchIntensityPreset(17, 4), null);
});

test('resolveIntensityFromSettings marks unmatched values as custom', () => {
    const custom = resolveIntensityFromSettings({ max_results: 50, max_iterations: 5 });
    assert.equal(custom.id, 'custom');
    assert.equal(custom.isCustom, true);
    assert.match(custom.hint, /50/);
    assert.match(custom.hint, /5/);

    const balanced = resolveIntensityFromSettings({ max_results: 12, max_iterations: 5 });
    assert.equal(balanced.id, 'balanced');
    assert.equal(balanced.isCustom, false);
});

test('applyIntensityPresetToSettings updates max_results and max_iterations', () => {
    const next = applyIntensityPresetToSettings(
        { max_results: 50, max_iterations: 5, search_engine: 'google' },
        'quick'
    );
    assert.equal(next.max_results, 8);
    assert.equal(next.max_iterations, 3);
    assert.equal(next.search_engine, 'google');
});

test('clamp helpers respect product limits', () => {
    assert.equal(clampMaxResults(0), 1);
    assert.equal(clampMaxResults(99), 50);
    assert.equal(clampMaxIterations(0), 1);
    assert.equal(clampMaxIterations(99), 10);
});

test('updateIntensityUI selects chip and shows custom when needed', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="search-intensity-bar">
        <div class="search-intensity-presets">
          <button class="intensity-chip" data-intensity="quick" role="radio"></button>
          <button class="intensity-chip" data-intensity="balanced" role="radio"></button>
          <button class="intensity-chip" data-intensity="deep" role="radio"></button>
          <button class="intensity-chip" data-intensity="research" role="radio"></button>
          <button class="intensity-chip intensity-chip-custom" data-intensity="custom" role="radio" hidden></button>
        </div>
        <div id="search-intensity-hint"></div>
      </div>
    </body></html>`);

    const { document } = dom.window;
    const resolved = updateIntensityUI({
        maxResults: 12,
        maxIterations: 5,
        root: document,
    });
    assert.equal(resolved.id, 'balanced');
    assert.equal(document.querySelector('.intensity-chip[data-intensity="balanced"]').classList.contains('active'), true);
    assert.equal(document.querySelector('.intensity-chip[data-intensity="custom"]').hidden, true);
    assert.equal(document.getElementById('search-intensity-bar').dataset.activeIntensity, 'balanced');
    assert.match(document.getElementById('search-intensity-hint').textContent, /12/);

    updateIntensityUI({ maxResults: 17, maxIterations: 2, root: document });
    assert.equal(document.querySelector('.intensity-chip[data-intensity="custom"]').hidden, false);
    assert.equal(document.querySelector('.intensity-chip[data-intensity="custom"]').classList.contains('active'), true);
    assert.equal(document.querySelector('.intensity-chip[data-intensity="deep"]').classList.contains('active'), false);
    assert.equal(document.getElementById('search-intensity-bar').dataset.activeIntensity, 'custom');
});
