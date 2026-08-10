// ===========================================================================
// Composer extras — UI aligned with AMC-WebUI's ChatSuggestions /
// SlashCommandMenu / LiveStatusBanner.
//
//   • Suggestion chips   — horizontal, scrollable row of preset questions,
//                          shown only while the conversation is empty.
//   • Slash command menu — type "/" to switch the search-intensity preset.
//   • Generation status  — a pill mirroring the send/stop state, so the
//                          running search is visible above the composer.
//
// The module is self-contained: it observes the hero (empty state) and the
// send button (.processing) so it needs no chat.js wiring beyond the two
// callbacks for sending and for applying an intensity preset.
// ===========================================================================
import { abortActiveStream } from './state.js?v=5';
import { t } from './i18n.js?v=1';
import { INTENSITY_PRESETS } from './search-intensity.js?v=3';

// --- Suggestion data (search-domain prompts) -------------------------------
export const SUGGESTIONS = Object.freeze([
    { icon: 'trending_up', textKey: 'composer.suggestion1' },
    { icon: 'compare_arrows', textKey: 'composer.suggestion2' },
    { icon: 'lightbulb', textKey: 'composer.suggestion3' },
    { icon: 'rocket_launch', textKey: 'composer.suggestion4' },
    { icon: 'eco', textKey: 'composer.suggestion5' },
    { icon: 'school', textKey: 'composer.suggestion6' },
    { icon: 'monitoring', textKey: 'composer.suggestion7' },
]);

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
    heroEl,
    root = document,
    onPickSuggestion,
    onApplyIntensity,
    getStatusText = () => null, // () => { title, subtitle } | null
}) {
    if (!inputEl) return null;

    const inputArea = inputEl.closest('#input-area') || root.getElementById('input-area');
    const chipsBox = inputArea?.querySelector('#suggestion-chips');
    const chipsTrack = inputArea?.querySelector('#suggestion-chips-track');
    const chipsLeft = inputArea?.querySelector('#suggestion-scroll-left');
    const chipsRight = inputArea?.querySelector('#suggestion-scroll-right');
    const slashMenu = inputArea?.querySelector('#slash-command-menu');
    const slashList = inputArea?.querySelector('#slash-command-list');
    const statusPill = inputArea?.querySelector('#generation-status');
    const statusTitle = inputArea?.querySelector('#generation-status-title');
    const statusSubtitle = inputArea?.querySelector('#generation-status-subtitle');
    const statusStop = inputArea?.querySelector('#generation-status-stop');

    // ------------------------------------------------------------------
    // Suggestion chips
    // ------------------------------------------------------------------
    let selectedIndex = 0;

    function renderChips() {
        if (!chipsTrack || chipsTrack.dataset.rendered) return;
        chipsTrack.dataset.rendered = '1';
        const frag = root.createDocumentFragment();
        SUGGESTIONS.forEach((s, i) => {
            const btn = root.createElement('button');
            btn.type = 'button';
            btn.className = 'suggestion-chip';
            btn.setAttribute('role', 'listitem');
            btn.dataset.suggestionIndex = String(i);
            const chipText = t(s.textKey);
            btn.title = chipText;
            btn.innerHTML = `<span class="material-symbols-rounded suggestion-chip-icon" aria-hidden="true">${s.icon}</span><span class="suggestion-chip-text">${chipText}</span>`;
            btn.addEventListener('click', () => {
                if (typeof onPickSuggestion === 'function') onPickSuggestion(chipText);
            });
            frag.appendChild(btn);
        });
        chipsTrack.appendChild(frag);
    }

    function updateChipScrollArrows() {
        if (!chipsTrack || !chipsLeft || !chipsRight) return;
        const { scrollLeft, scrollWidth, clientWidth } = chipsTrack;
        const showLeft = scrollLeft > 4;
        const showRight = scrollLeft < scrollWidth - clientWidth - 4;
        chipsLeft.classList.toggle('is-visible', showLeft);
        chipsRight.classList.toggle('is-visible', showRight);
    }

    if (chipsTrack) {
        chipsTrack.addEventListener('scroll', updateChipScrollArrows, { passive: true });
    }
    const scrollChips = (dir) => {
        if (!chipsTrack) return;
        chipsTrack.scrollBy({ left: dir * chipsTrack.clientWidth * 0.6, behavior: 'smooth' });
    };
    if (chipsLeft) chipsLeft.addEventListener('click', () => scrollChips(-1));
    if (chipsRight) chipsRight.addEventListener('click', () => scrollChips(1));

    // Show/hide with the empty-state hero (the app drives hero visibility via
    // inline style.display, so read it directly rather than getComputedStyle).
    const raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 0);
    function syncSuggestionsVisibility() {
        if (!chipsBox || !heroEl) return;
        const heroVisible = heroEl.style.display !== 'none';
        chipsBox.hidden = !heroVisible;
        if (heroVisible) {
            renderChips();
            // Wait a frame so the track has layout before measuring overflow.
            raf(updateChipScrollArrows);
        }
    }
    if (heroEl && chipsBox) {
        syncSuggestionsVisibility();
        try {
            const mo = new MutationObserver(syncSuggestionsVisibility);
            mo.observe(heroEl, { attributes: true, attributeFilter: ['style'] });
        } catch { /* older test env without MutationObserver */ }
        window.addEventListener('resize', updateChipScrollArrows);
    }

    // ------------------------------------------------------------------
    // Slash command menu
    // ------------------------------------------------------------------
    function isSlashOpen() {
        return slashMenu && !slashMenu.hidden;
    }

    function openSlashMenu() {
        if (!slashMenu || !slashList) return;
        const query = (inputEl.value || '').trim();
        const match = query.match(SLASH_RE);
        const filter = match ? match[1].toLowerCase() : '';
        const commands = SLASH_COMMANDS.filter((c) => getSlashCommandLabel(c).toLowerCase().includes(filter));
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
            syncSuggestionsVisibility();
            updateStatusPill();
        },
        openSlashMenu,
        closeSlashMenu,
        isSlashOpen,
    };
}
