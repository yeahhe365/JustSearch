// ===========================================================================
// Settings segmented control — AMC-style radiogroup replacing the theme /
// language <select>. Zero imports so settings-modal.js and sidebar.js can
// both use it without cycles.
// ===========================================================================

function findGroup(key) {
    return document.querySelector(`.settings-segmented[data-settings-key="${key}"]`);
}

export function getSegmentedValue(key) {
    const group = findGroup(key);
    if (!group) return null;
    return group.querySelector('.settings-segment[aria-checked="true"]')?.dataset.value ?? null;
}

export function setSegmentedValue(key, value, { silent = false } = {}) {
    const group = findGroup(key);
    if (!group) return false;
    const segments = Array.from(group.querySelectorAll('.settings-segment'));
    const target = segments.find((btn) => btn.dataset.value === String(value));
    if (!target) return false;
    if (target.getAttribute('aria-checked') !== 'true') {
        segments.forEach((btn) => btn.setAttribute('aria-checked', btn === target ? 'true' : 'false'));
        if (!silent) {
            group.dispatchEvent(new CustomEvent('segmentedchange', { bubbles: true, detail: { key, value: target.dataset.value } }));
        }
    }
    return true;
}

/** Wire click + keyboard (←/→/↑/↓/Home/End) on every group. Idempotent. */
export function initSegmentedGroups({ onChange } = {}) {
    document.querySelectorAll('.settings-segmented').forEach((group) => {
        if (group.dataset.segmentedInitialized) return;
        group.dataset.segmentedInitialized = '1';
        const key = group.dataset.settingsKey;
        const segments = Array.from(group.querySelectorAll('.settings-segment'));
        const activate = (btn) => {
            if (!btn || btn.getAttribute('aria-checked') === 'true') return;
            segments.forEach((s) => s.setAttribute('aria-checked', s === btn ? 'true' : 'false'));
            group.dispatchEvent(new CustomEvent('segmentedchange', { bubbles: true, detail: { key, value: btn.dataset.value } }));
            if (typeof onChange === 'function') onChange({ key, value: btn.dataset.value });
        };
        segments.forEach((btn) => {
            btn.addEventListener('click', () => activate(btn));
            btn.addEventListener('keydown', (e) => {
                const idx = segments.indexOf(btn);
                let next = null;
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = segments[(idx + 1) % segments.length];
                else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = segments[(idx - 1 + segments.length) % segments.length];
                else if (e.key === 'Home') next = segments[0];
                else if (e.key === 'End') next = segments[segments.length - 1];
                if (next) { e.preventDefault(); next.focus(); activate(next); }
            });
        });
    });
}
