// ===========================================================================
// Settings dropdown — AMC Select look as progressive enhancement over native
// <select class="settings-select">. The select stays in the DOM (hidden) so
// every existing change listener keeps working.
// ===========================================================================

const CHEVRON = '<svg class="settings-dd-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

function labelFor(select) {
    return select.options[select.selectedIndex]?.textContent ?? '';
}

export function syncFromSelect(select) {
    const wrap = select.closest('.settings-dd');
    if (!wrap) return;
    wrap.querySelector('.settings-dd-label').textContent = labelFor(select);
    wrap.querySelectorAll('.settings-dd-option').forEach((opt) => {
        const isSel = opt.dataset.value === String(select.value);
        opt.setAttribute('aria-selected', isSel ? 'true' : 'false');
        opt.classList.toggle('is-selected', isSel);
    });
}

export function initSettingsDropdowns(root = document) {
    root.querySelectorAll('select.settings-select').forEach((select) => {
        if (select.dataset.ddUpgraded) return;
        select.dataset.ddUpgraded = '1';

        const wrap = root.createElement('div');
        wrap.className = 'settings-dd';
        const trigger = root.createElement('button');
        trigger.type = 'button';
        trigger.className = 'settings-dd-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.innerHTML = `<span class="settings-dd-label"></span>${CHEVRON}`;
        const panel = root.createElement('div');
        panel.className = 'settings-dd-panel';
        panel.setAttribute('role', 'listbox');

        Array.from(select.options).forEach((option) => {
            const opt = root.createElement('button');
            opt.type = 'button';
            opt.className = 'settings-dd-option';
            opt.setAttribute('role', 'option');
            opt.dataset.value = option.value;
            opt.textContent = option.textContent;
            opt.addEventListener('click', () => {
                if (String(select.value) !== option.value) {
                    select.value = option.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
                close();
            });
            panel.appendChild(opt);
        });

        function open() { panel.hidden = false; trigger.setAttribute('aria-expanded', 'true'); }
        function close() { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
        trigger.addEventListener('click', () => (panel.hidden ? open() : close()));
        trigger.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { close(); e.stopPropagation(); }
        });
        root.addEventListener('click', (e) => {
            if (!wrap.contains(e.target)) close();
        });

        select.parentNode.insertBefore(wrap, select);
        wrap.appendChild(trigger);
        wrap.appendChild(panel);
        wrap.appendChild(select); // keep select inside for closest('.settings-dd')
        select.classList.add('sr-only-native');
        syncFromSelect(select);
    });
}
