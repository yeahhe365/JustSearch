/**
 * Composer expand & resize — vanilla port of AMC useChatInputExpandSizing +
 * ChatInputExpandCorner. All magic numbers mirror the React source exactly:
 * expand target max(220px, 50vh), collapse cap max(220px, 40vh),
 * height transition 260ms cubic-bezier(0,0,0.2,1), keyboard step ±16px.
 */
import { t } from './i18n.js?v=1';

const EXPANDED_MIN_PX = 220;
const EXPANDED_RATIO = 0.5;   // max(220px, 50vh)
const COLLAPSED_RATIO = 0.4;  // collapse target cap max(220px, 40vh)
const HEIGHT_TRANSITION_MS = 260;
const RESIZE_KEYBOARD_STEP = 16;

/** True while the textarea height is owned by the expand/resize feature. */
export function isComposerCustomHeight(textareaEl) {
    return textareaEl?.dataset?.customHeight === 'true';
}

export function setupComposerExpand({ inputBoxEl, textareaEl }) {
    if (!inputBoxEl || !textareaEl) return null;
    if (inputBoxEl.dataset.expandInitialized === 'true') return null;
    inputBoxEl.dataset.expandInitialized = 'true';

    const frame = inputBoxEl.querySelector('.composer-editor-frame') || textareaEl.parentElement;
    const handle = inputBoxEl.querySelector('.composer-resize-handle');
    const expandBtn = inputBoxEl.querySelector('.composer-expand-btn');

    let expanded = false;
    let manualHeight = null;      // number | null (px)
    let animatedHeight = null;    // string | null (during transitions)
    let isResizing = false;
    let rafId = null;
    let settleTimer = null;
    let dragState = null;

    const minHeightPx = () => {
        let parsed = NaN;
        try { parsed = parseFloat(window.getComputedStyle(textareaEl).minHeight); } catch (_) { /* jsdom/edge */ }
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 26;
    };
    const viewportPx = (ratio) => Math.max(EXPANDED_MIN_PX, Math.round(window.innerHeight * ratio));
    const expandedMaxPx = () => viewportPx(EXPANDED_RATIO);
    const collapsedCapPx = () => viewportPx(COLLAPSED_RATIO);
    const clampHeight = (h) => Math.min(expandedMaxPx(), Math.max(minHeightPx(), Math.round(h)));
    const hasCustomHeight = () => expanded || manualHeight !== null;

    // AMC getCollapsedHeightPx: measure the textarea's natural content height.
    function measureCollapsedHeight() {
        const prev = textareaEl.style.height;
        try {
            textareaEl.style.height = 'auto';
            const natural = textareaEl.scrollHeight || minHeightPx();
            return Math.min(collapsedCapPx(), Math.max(minHeightPx(), Math.round(natural)));
        } finally {
            textareaEl.style.height = prev || '';
        }
    }

    function clearRaf() {
        if (rafId !== null && window.cancelAnimationFrame) window.cancelAnimationFrame(rafId);
        rafId = null;
    }

    function applyFrameStyle() {
        const resolved = animatedHeight
            ?? (expanded ? 'max(220px, 50vh)' : manualHeight !== null ? `${manualHeight}px` : '');
        frame.style.height = resolved;
        frame.style.minHeight = `${minHeightPx()}px`;
        frame.style.overflow = 'hidden';
        frame.style.transition = isResizing ? 'none' : `height ${HEIGHT_TRANSITION_MS}ms cubic-bezier(0, 0, 0.2, 1)`;

        if (hasCustomHeight()) {
            textareaEl.style.height = '100%';
            textareaEl.style.overflowY = 'auto';
        } else {
            textareaEl.style.height = '';
            textareaEl.style.overflowY = 'hidden';
        }
        textareaEl.dataset.customHeight = String(hasCustomHeight());
        inputBoxEl.classList.toggle('expanded', hasCustomHeight());

        if (handle) {
            handle.setAttribute('aria-valuemin', String(minHeightPx()));
            handle.setAttribute('aria-valuemax', String(expandedMaxPx()));
            handle.setAttribute('aria-valuenow', String(expanded ? expandedMaxPx() : (manualHeight ?? minHeightPx())));
            if (isResizing) handle.setAttribute('data-resizing', '');
            else handle.removeAttribute('data-resizing');
        }
    }

    // AMC: clear the animated height once the transition settles (+80ms guard).
    function settleAfterTransition() {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
            animatedHeight = null;
            applyFrameStyle();
        }, HEIGHT_TRANSITION_MS + 80);
    }

    function syncExpandButton() {
        if (!expandBtn) return;
        expandBtn.setAttribute('aria-pressed', String(expanded));
        const labelKey = expanded ? 'inputArea.collapse' : 'inputArea.expand';
        expandBtn.title = t(labelKey);
        expandBtn.setAttribute('aria-label', labelKey);
    }

    function setExpanded(target) {
        const next = typeof target === 'boolean' ? target : !expanded;
        if (!next && manualHeight !== null) manualHeight = null;
        if (next === expanded && animatedHeight === null) { applyFrameStyle(); syncExpandButton(); return; }

        // Animate from the current rendered height to the new target.
        animatedHeight = `${frame.offsetHeight || minHeightPx()}px`;
        expanded = next;
        applyFrameStyle();
        syncExpandButton();
        if (window.requestAnimationFrame) {
            clearRaf();
            rafId = requestAnimationFrame(() => {
                const targetHeight = expanded ? viewportPx(EXPANDED_RATIO) : measureCollapsedHeight();
                animatedHeight = `${targetHeight}px`;
                applyFrameStyle();
                settleAfterTransition();
                rafId = null;
            });
        } else {
            animatedHeight = null;
            applyFrameStyle();
        }
        textareaEl.focus({ preventScroll: true });
    }

    function endDrag() {
        isResizing = false;
        dragState = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', endDrag);
        applyFrameStyle();
    }

    function onDragMove(event) {
        if (!dragState) return;
        // Dragging out of the expanded state drops into manual sizing (AMC parity).
        if (dragState.exitExpandedOnMove) {
            dragState.exitExpandedOnMove = false;
            expanded = false;
            syncExpandButton();
        }
        manualHeight = clampHeight(dragState.startHeight + dragState.startClientY - event.clientY);
        applyFrameStyle();
    }

    function startDrag(event) {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        dragState = {
            startClientY: event.clientY,
            startHeight: frame.offsetHeight || manualHeight || minHeightPx(),
            exitExpandedOnMove: expanded,
        };
        isResizing = true;
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', endDrag);
        applyFrameStyle();
    }

    function onHandleKeyDown(event) {
        const current = frame.offsetHeight || (manualHeight ?? minHeightPx());
        let next = null;
        if (event.key === 'ArrowUp') next = current + RESIZE_KEYBOARD_STEP;
        else if (event.key === 'ArrowDown') next = current - RESIZE_KEYBOARD_STEP;
        else if (event.key === 'Home') next = minHeightPx();
        else if (event.key === 'End') next = expandedMaxPx();
        if (next === null) return;
        event.preventDefault();
        expanded = false;
        manualHeight = clampHeight(next);
        syncExpandButton();
        applyFrameStyle();
    }

    if (expandBtn) expandBtn.addEventListener('click', () => setExpanded());
    if (handle) {
        handle.addEventListener('mousedown', startDrag);
        handle.addEventListener('keydown', onHandleKeyDown);
    }
    const onVisibility = () => { if (document.hidden) endDrag(); };
    document.addEventListener('visibilitychange', onVisibility);

    applyFrameStyle();

    return {
        toggle: () => setExpanded(),
        isExpanded: () => expanded,
        hasCustomHeight,
    };
}
