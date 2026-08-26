// ===========================================================================
// Composer extras — UI aligned with AMC-WebUI's SlashCommandMenu /
// LiveStatusBanner.
//
//   • Slash command menu — type "/" to switch the search-intensity preset.
//   • Generation status  — a pill mirroring the send/stop state, so the
//                          running search is visible above the composer.
//
// The module is self-contained: it observes the send button (.processing) so
// it needs no chat.js wiring beyond the callbacks for applying an intensity
// preset and for reading status labels.
// ===========================================================================
import { abortActiveStream } from './state.js?v=5';
import { t } from './i18n.js?v=1';
import { INTENSITY_PRESETS } from './search-intensity.js?v=3';

// --- Slash command data (derived from search-intensity presets) ------------
const SLASH_COMMAND_ICONS = Object.freeze({
    quick: 'bolt',
    balanced: 'balance',
    deep: 'travel_explore',
    research: 'science',
});

export const SLASH_COMMANDS = Object.freeze(
    INTENSITY_PRESETS.map((preset) => ({
        id: preset.id,
        icon: SLASH_COMMAND_ICONS[preset.id] || 'bolt',
        labelKey: preset.labelKey,
        hintKey: preset.hintKey,
    })),
);

export function getSlashCommandLabel(c) { return t(c.labelKey); }
export function getSlashCommandHint(c) { return t(c.hintKey); }

const SLASH_RE = /^\/([^\s]*)/;

/**
 * Wire up the three composer extras. Returns a handle with an update()
 * method for re-reading the processing/intensity labels.
 */
export function setupComposerExtras({
    inputEl,
    sendBtn,
    root = document,
    onApplyIntensity,
    getStatusText = () => null, // () => { title, subtitle } | null
}) {
    if (!inputEl) return null;

    const inputArea = inputEl.closest('#input-area') || root.getElementById('input-area');
    const slashMenu = inputArea?.querySelector('#slash-command-menu');
    const slashList = inputArea?.querySelector('#slash-command-list');
    const statusPill = inputArea?.querySelector('#generation-status');
    const statusTitle = inputArea?.querySelector('#generation-status-title');
    const statusSubtitle = inputArea?.querySelector('#generation-status-subtitle');
    const statusStop = inputArea?.querySelector('#generation-status-stop');

    // ------------------------------------------------------------------
    // Slash command menu
    // ------------------------------------------------------------------
    let selectedIndex = 0;

    function isSlashOpen() {
        return slashMenu && !slashMenu.hidden;
    }

    function openSlashMenu() {
        if (!slashMenu || !slashList) return;
        const query = (inputEl.value || '').trim();
        const match = query.match(SLASH_RE);
        const filter = match ? match[1].toLowerCase() : '';
        // 同时匹配 id / label / hint：id 是稳定的拉丁词（如 quick/deep），
        // 翻译后的中文标签下输入 "/quick" 也应能命中。
        const commands = SLASH_COMMANDS.filter((c) => (
            [c.id, getSlashCommandLabel(c), getSlashCommandHint(c)].join(' ').toLowerCase().includes(filter)
        ));
        slashList.textContent = '';
        selectedIndex = 0;
        if (!commands.length) {
            const empty = root.createElement('div');
            empty.className = 'slash-command-empty';
            empty.textContent = t('composer.noMatch');
            slashList.appendChild(empty);
        } else {
            commands.forEach((c, i) => {
                const item = root.createElement('button');
                item.type = 'button';
                item.className = 'slash-command-item';
                item.setAttribute('role', 'option');
                item.dataset.commandId = c.id;
                item.innerHTML = `<span class="material-symbols-rounded slash-command-icon" aria-hidden="true">${c.icon}</span><span class="slash-command-label">${getSlashCommandLabel(c)}</span><span class="slash-command-hint">${getSlashCommandHint(c)}</span>`;
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault(); // keep input focus
                    runSlashCommand(c);
                });
                item.addEventListener('mouseenter', () => setSlashSelection(i));
                slashList.appendChild(item);
            });
            setSlashSelection(0);
        }
        slashMenu.hidden = false;
    }

    function closeSlashMenu() {
        if (slashMenu) slashMenu.hidden = true;
    }

    function setSlashSelection(index) {
        if (!slashList) return;
        const items = Array.from(slashList.querySelectorAll('.slash-command-item'));
        if (!items.length) return;
        selectedIndex = Math.max(0, Math.min(index, items.length - 1));
        items.forEach((it, i) => {
            it.classList.toggle('selected', i === selectedIndex);
            it.setAttribute('aria-selected', i === selectedIndex ? 'true' : 'false');
        });
        items[selectedIndex]?.scrollIntoView?.({ block: 'nearest' });
    }

    function runSlashCommand(cmd) {
        closeSlashMenu();
        // Strip the leading "/command" token, keep whatever the user typed after it.
        const current = (inputEl.value || '').trim();
        const rest = current.replace(SLASH_RE, '').trim();
        inputEl.value = rest;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        if (typeof onApplyIntensity === 'function') {
            onApplyIntensity(cmd.id, cmd);
        }
        if (inputEl.focus) inputEl.focus();
    }

    if (inputEl) {
        inputEl.addEventListener('input', () => {
            const v = (inputEl.value || '').trim();
            if (v.startsWith('/')) {
                openSlashMenu();
            } else {
                closeSlashMenu();
            }
        });
        // Capture phase so the menu handles keys before chat.js's own
        // (bubble-phase) keydown handlers (ArrowUp-edit, Ctrl+Enter, Esc).
        inputEl.addEventListener(
            'keydown',
            (e) => {
                if (!isSlashOpen()) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setSlashSelection(selectedIndex + 1); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setSlashSelection(selectedIndex - 1); }
                else if (e.key === 'Enter' || e.key === 'Tab') {
                    const item = slashList?.querySelector('.slash-command-item.selected');
                    if (item) { e.preventDefault(); e.stopPropagation(); runSlashCommand(SLASH_COMMANDS.find((c) => c.id === item.dataset.commandId)); }
                } else if (e.key === 'Escape') {
                    e.preventDefault(); e.stopPropagation(); closeSlashMenu();
                }
            },
            true,
        );
    }

    // Close the menu when clicking elsewhere.
    if (inputArea) {
        inputArea.addEventListener('click', (e) => {
            if (isSlashOpen() && !e.target.closest('#slash-command-menu')) closeSlashMenu();
        });
    }

    // ------------------------------------------------------------------
    // Generation status pill (mirrors the send button's .processing)
    // ------------------------------------------------------------------
    function updateStatusPill() {
        if (!statusPill) return;
        const processing = sendBtn && sendBtn.classList.contains('processing');
        if (processing) {
            const st = getStatusText ? getStatusText() : null;
            if (st) {
                if (statusTitle) statusTitle.textContent = st.title || t('chat.searching');
                if (statusSubtitle) statusSubtitle.textContent = st.subtitle || '';
            }
            statusPill.hidden = false;
        } else {
            statusPill.hidden = true;
        }
    }
    if (sendBtn && statusPill) {
        updateStatusPill();
        try {
            const mo = new MutationObserver(updateStatusPill);
            mo.observe(sendBtn, { attributes: true, attributeFilter: ['class'] });
        } catch { /* older test env */ }
    }
    if (statusStop) {
        statusStop.addEventListener('click', () => {
            abortActiveStream();
            if (inputEl) inputEl.focus({ preventScroll: true });
        });
    }

    return {
        update: () => {
            updateStatusPill();
        },
        openSlashMenu,
        closeSlashMenu,
        isSlashOpen,
    };
}
