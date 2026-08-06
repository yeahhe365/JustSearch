// ===========================================================================
// Text-selection toolbar — AMC-aligned (TextSelectionToolbar equivalent).
//
// Select text inside a chat message to reveal a floating Copy / Quote / Search
// toolbar. The module owns its DOM and listens for selectionchange; it exposes
// show/hide so tests and other code can drive it directly.
// ===========================================================================

function getSelectedRangeInfo(containerEl, root) {
    const selection = (root.getSelection ? root.getSelection() : null) || window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;

    let node = selection.anchorNode;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    if (!node || !containerEl.contains(node)) return null;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text, rect };
}

export function setupTextSelectionToolbar({
    containerEl,
    inputEl,
    root = document,
    onCopy,
    onQuote,
    onSearch,
}) {
    const toolbar = root.getElementById('text-selection-toolbar');
    if (!toolbar || !containerEl) return null;

    let currentText = '';
    let hideTimer = null;

    const copyBtn = toolbar.querySelector('.text-selection-copy');
    const quoteBtn = toolbar.querySelector('.text-selection-quote');
    const searchBtn = toolbar.querySelector('.text-selection-search');

    function positionToolbar(rect) {
        const tw = toolbar.offsetWidth || 180;
        const th = toolbar.offsetHeight || 36;
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        let x = rect.left + rect.width / 2 - tw / 2;
        x = Math.max(8, Math.min(x, Math.max(8, vw - tw - 8)));
        let y = rect.top - th - 10;
        if (y < 8) y = rect.bottom + 10;
        if (y + th > vh - 8) y = Math.max(8, vh - th - 8);
        toolbar.style.left = `${x}px`;
        toolbar.style.top = `${y}px`;
    }

    function show(text, rect) {
        clearTimeout(hideTimer);
        currentText = text;
        toolbar.hidden = false;
        toolbar.classList.add('is-visible');
        positionToolbar(rect);
    }

    function hide() {
        clearTimeout(hideTimer);
        toolbar.classList.remove('is-visible');
    }

    function scheduleHide() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, 150);
    }

    function handleSelectionChange() {
        const info = getSelectedRangeInfo(containerEl, root);
        if (info) show(info.text, info.rect);
        else scheduleHide();
    }

    function clearSelection() {
        const selection = (root.getSelection ? root.getSelection() : null) || window.getSelection();
        if (selection && selection.removeAllRanges) selection.removeAllRanges();
    }

    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            if (typeof onCopy === 'function') {
                onCopy(currentText);
            } else {
                try {
                    await navigator.clipboard.writeText(currentText);
                } catch {
                    const ta = root.createElement('textarea');
                    ta.value = currentText;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    root.body.appendChild(ta);
                    ta.select();
                    try { root.execCommand('copy'); } catch { /* ignore */ }
                    ta.remove();
                }
            }
            hide();
            clearSelection();
        });
    }

    if (quoteBtn) {
        quoteBtn.addEventListener('click', () => {
            if (typeof onQuote === 'function') {
                onQuote(currentText);
            } else if (inputEl) {
                const existing = inputEl.value ? `${inputEl.value.trim()}\n\n` : '';
                inputEl.value = `${existing}> ${currentText.replace(/\n/g, '\n> ')}`;
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                inputEl.focus({ preventScroll: true });
            }
            hide();
            clearSelection();
        });
    }

    if (searchBtn) {
        searchBtn.addEventListener('click', () => {
            if (typeof onSearch === 'function') {
                onSearch(currentText);
            } else {
                window.open(`https://www.google.com/search?q=${encodeURIComponent(currentText)}`, '_blank', 'noopener,noreferrer');
            }
            hide();
            clearSelection();
        });
    }

    containerEl.addEventListener('scroll', hide, { passive: true });
    root.addEventListener('mousedown', (e) => {
        if (!e.target.closest('#text-selection-toolbar')) hide();
    });
    root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hide();
    });
    root.addEventListener('selectionchange', handleSelectionChange);

    return {
        show,
        hide,
        isVisible: () => toolbar.classList.contains('is-visible') && !toolbar.hidden,
        getText: () => currentText,
    };
}
