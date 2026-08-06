// 初始化 markdown-it with highlight.js
import { t } from './i18n.js?v=1';

const mdInstance = window.markdownit({
    html: true,
    linkify: true,
    typographer: true,
    highlight: function (str, lang) {
        if (lang && window.hljs && hljs.getLanguage(lang)) {
            try {
                return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
            } catch (__) {}
        }
        if (window.hljs) {
            try {
                return hljs.highlightAuto(str).value;
            } catch (__) {}
        }
        return mdInstance.utils.escapeHtml(str);
    }
});

export const md = {
    render: (text) => {
        const rawHtml = mdInstance.render(text);
        const sanitized = window.DOMPurify.sanitize(rawHtml, {
            ADD_ATTR: ['target'],
            FORBID_TAGS: ['style', 'form', 'input'],
            FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick', 'onmouseover'],
        });
        // 为所有链接添加 target="_blank"，在新标签页打开
        const withTarget = sanitized.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
        // 为代码块添加包装器（不含 onclick，用事件委托处理复制）
        return withTarget.replace(/<pre><code([^>]*)>/g, (match, attrs) => {
            return `<pre class="code-block-wrapper"><div class="code-block-header"><span class="code-block-lang">${escapeHtml(extractLangFromAttrs(attrs))}</span><button class="code-copy-btn" data-action="copy-code" title="${t('ui.copyCode')}"><span class="material-symbols-rounded">content_copy</span><span>${t('ui.copy')}</span></button></div><code${attrs}>`;
        });
    }
};

function extractLangFromAttrs(attrs) {
    const m = attrs.match(/class="[^"]*language-([^"\s]+)[^"]*"/);
    return m ? m[1] : 'TEXT';
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[char]));
}

// 全局事件委托：处理代码块复制按钮
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="copy-code"]');
    if (!btn) return;
    const pre = btn.closest('pre');
    const code = pre ? pre.querySelector('code') : null;
    if (!code) return;
    try {
        await navigator.clipboard.writeText(code.textContent);
        const icon = btn.querySelector('.material-symbols-rounded');
        const textSpan = btn.querySelector('span:not(.material-symbols-rounded)');
        icon.textContent = 'check';
        if(textSpan) textSpan.textContent = t('ui.copied');
        btn.style.color = 'var(--success)';

        setTimeout(() => {
            icon.textContent = 'content_copy';
            if(textSpan) textSpan.textContent = t('ui.copy');
            btn.style.color = '';
        }, 2000);
    } catch (err) { console.error('Copy failed:', err); }
});

const THEME_STORAGE_KEY = 'justsearch_theme';

// Mirrors AMC baseFontSize / liveArtifactsCustomFontSize ranges.
export const BASE_FONT_SIZE_MIN = 12;
export const BASE_FONT_SIZE_MAX = 24;
export const DEFAULT_BASE_FONT_SIZE = 16;
export const LIVE_ARTIFACTS_FONT_SIZE_MIN = 10;
export const LIVE_ARTIFACTS_FONT_SIZE_MAX = 32;
export const DEFAULT_LIVE_ARTIFACTS_FONT_SIZE = 16;

export function clampBaseFontSize(value) {
    return clampFontSize(value, DEFAULT_BASE_FONT_SIZE, BASE_FONT_SIZE_MIN, BASE_FONT_SIZE_MAX);
}

export function clampLiveArtifactsFontSize(value) {
    return clampFontSize(
        value,
        DEFAULT_LIVE_ARTIFACTS_FONT_SIZE,
        LIVE_ARTIFACTS_FONT_SIZE_MIN,
        LIVE_ARTIFACTS_FONT_SIZE_MAX,
    );
}

export function resolveBaseFontSize(settings) {
    return clampBaseFontSize(settings?.base_font_size ?? DEFAULT_BASE_FONT_SIZE);
}

export function resolveLiveArtifactsFontSize(settings) {
    return clampLiveArtifactsFontSize(
        settings?.live_artifacts_font_size ?? DEFAULT_LIVE_ARTIFACTS_FONT_SIZE,
    );
}

function clampFontSize(value, fallback, minSize, maxSize) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maxSize, Math.max(minSize, Math.round(parsed)));
}

/**
 * Apply reading + Live Artifacts base font sizes via CSS variables on <html>.
 * Message bubbles and interaction frames consume these vars; iframe srcdocs
 * read the LA size when building preview documents.
 */
export function applyFontSizes(settings) {
    if (typeof document === 'undefined') return {
        baseFontSize: resolveBaseFontSize(settings),
        liveArtifactsFontSize: resolveLiveArtifactsFontSize(settings),
    };
    const baseFontSize = resolveBaseFontSize(settings);
    const liveArtifactsFontSize = resolveLiveArtifactsFontSize(settings);
    const root = document.documentElement;
    root.style.setProperty('--js-base-font-size', `${baseFontSize}px`);
    root.style.setProperty('--js-live-artifacts-font-size', `${liveArtifactsFontSize}px`);
    return { baseFontSize, liveArtifactsFontSize };
}

export function applyTheme(theme) {
    // 持久化到 localStorage，供 <head> 内联脚本在下次加载时同步读取，避免 FOUC。
    try {
        if (theme) {
            localStorage.setItem(THEME_STORAGE_KEY, theme);
        }
    } catch (e) { /* localStorage 不可用时静默降级 */ }

    if (!theme || theme === 'auto') {
        // Auto-detect system preference
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
        _updateHljsTheme(prefersDark);
    } else {
        document.documentElement.setAttribute('data-theme', theme);
        _updateHljsTheme(theme === 'dark');
    }

    // Rebuild open Live Artifact iframes so dark/light theme tokens stay readable.
    // Mirrors AMC re-injecting --amc-live-artifact-* when themeId changes.
    import('./live-artifacts.js?v=50')
        .then((mod) => {
            if (typeof mod.refreshLiveArtifactPreviews === 'function') {
                mod.refreshLiveArtifactPreviews({ theme: document.documentElement.getAttribute('data-theme') });
            } else if (typeof mod.refreshLiveArtifactFontSizes === 'function') {
                mod.refreshLiveArtifactFontSizes();
            }
        })
        .catch(() => {
            // Live Artifacts module may be unavailable in some test harnesses.
        });
}

function _updateHljsTheme(isDark) {
    const darkSheet = document.getElementById('hljs-dark');
    const lightSheet = document.getElementById('hljs-light');
    if (darkSheet) darkSheet.disabled = !isDark;
    if (lightSheet) lightSheet.disabled = isDark;
}

/**
 * Strip markdown formatting to get plain text.
 */
export function stripMarkdown(mdText) {
    if (!mdText) return '';
    let text = mdText;
    text = text.replace(/```[\s\S]*?```/g, (match) => {
        const lines = match.split('\n');
        return lines.slice(1, lines.length - 1).join('\n');
    });
    text = text.replace(/`([^`]+)`/g, '$1');
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
    text = text.replace(/\[([^\]]*)\]\([^)]+\)/g, '$1');
    text = text.replace(/^#{1,6}\s+/gm, '');
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
    text = text.replace(/\*\*(.+?)\*\*/g, '$1');
    text = text.replace(/\*(.+?)\*/g, '$1');
    text = text.replace(/___(.+?)___/g, '$1');
    text = text.replace(/__(.+?)__/g, '$1');
    text = text.replace(/_(.+?)_/g, '$1');
    text = text.replace(/~~(.+?)~~/g, '$1');
    text = text.replace(/^>\s?/gm, '');
    text = text.replace(/^[-*_]{3,}\s*$/gm, '');
    text = text.replace(/^\s*[-*+]\s+/gm, '');
    text = text.replace(/^\s*\d+\.\s+/gm, '');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

export function createMessageActionButton(className, icon, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `message-action-btn ${className}`.trim();
    btn.innerHTML = `<span class="material-symbols-rounded">${icon}</span>`;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.onclick = onClick;
    return btn;
}

export function createMessageActionRail(buttons, label = t('ui.messageActions')) {
    const rail = document.createElement('div');
    rail.className = 'message-action-rail';
    rail.setAttribute('role', 'toolbar');
    rail.setAttribute('aria-label', label);

    buttons.filter(Boolean).forEach((button) => rail.appendChild(button));
    return rail;
}

export function createCopyButton(contentGetter) {
    const btn = createMessageActionButton('copy-btn', 'content_copy', t('ui.copy'), async (e) => {
        e.stopPropagation();
        const raw = typeof contentGetter === 'function' ? contentGetter() : contentGetter;
        if (!raw) return;

        const text = stripMarkdown(raw);

        try {
            await navigator.clipboard.writeText(text);
            const icon = btn.querySelector('span');
            icon.textContent = 'check';
            btn.classList.add('is-success');
            btn.title = t('ui.copied');
            btn.setAttribute('aria-label', t('ui.copied'));
            setTimeout(() => {
                icon.textContent = 'content_copy';
                btn.classList.remove('is-success');
                btn.title = t('ui.copy');
                btn.setAttribute('aria-label', t('ui.copy'));
            }, 1600);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    });
    btn.dataset.action = 'copy-message';

    return btn;
}

export function createEditMessageButton(contentGetter, onEdit) {
    const btn = createMessageActionButton('edit-message-btn', 'edit', t('ui.edit'), (e) => {
        e.stopPropagation();
        const raw = typeof contentGetter === 'function' ? contentGetter() : contentGetter;
        if (!raw) return;
        onEdit(raw);
    });
    btn.dataset.action = 'edit-message';
    return btn;
}

export function createRegenerateButton(onRegenerate) {
    const btn = createMessageActionButton('regenerate-btn', 'refresh', t('ui.regenerate'), async (e) => {
        e.stopPropagation();
        await onRegenerate();
    });
    btn.dataset.action = 'regenerate-message';
    return btn;
}

export function createDeleteMessageButton(onDelete) {
    const btn = createMessageActionButton('msg-delete-btn', 'delete', t('ui.delete'), async (e) => {
        e.stopPropagation();
        await onDelete();
    });
    btn.dataset.action = 'delete-message';
    return btn;
}

export function createForkMessageButton(onFork) {
    const btn = createMessageActionButton('fork-message-btn', 'fork_right', t('ui.forkFromHere'), async (e) => {
        e.stopPropagation();
        await onFork();
    });
    btn.dataset.action = 'fork-message';
    return btn;
}

function downloadTextFile(filename, text, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createExportMessageButton(contentGetter) {
    const btn = createMessageActionButton('export-message-btn', 'file_download', t('ui.exportMarkdown'), (e) => {
        e.stopPropagation();
        const raw = typeof contentGetter === 'function' ? contentGetter() : contentGetter;
        if (!raw) return;
        downloadTextFile('justsearch-message.md', raw, 'text/markdown;charset=utf-8');
    });
    btn.dataset.action = 'export-message';
    return btn;
}
