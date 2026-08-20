import { t } from './i18n.js?v=1';

// markdown-it 实例惰性创建：真实浏览器中 window.markdownit 由 index.html
// 引入；jsdom 测试可能在 import 之后才设置 mock。惰性化让 utils.js 顶层
// 无副作用，任何测试时序下都能安全 import。
let mdInstance = null;
function getMdInstance() {
    if (mdInstance) return mdInstance;
    if (typeof window === 'undefined' || typeof window.markdownit !== 'function') {
        return null;
    }
    mdInstance = window.markdownit({
        html: true,
        linkify: true,
        typographer: true,
        highlight: function (str, lang) {
            if (lang && window.hljs && hljs.getLanguage(lang)) {
                try {
                    return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
                } catch (__) {}
            }
            // AMC对齐：移除同步 highlightAuto（全量语言检测 ~80ms），流式先转义，空闲再高亮
            return mdInstance.utils.escapeHtml(str);
        }
    });
    return mdInstance;
}

export const md = {
    render: (text) => {
        const instance = getMdInstance();
        if (!instance) return String(text ?? '');
        const rawHtml = instance.render(text);
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

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[char]));
}

/**
 * Normalize a candidate URL to a safe http(s) absolute URL, or ''.
 * Shared by source/evidence/live-artifacts renderers.
 */
export function getSafeUrl(url) {
    try {
        const raw = String(url || '').trim();
        if (!raw) return '';
        let candidate = raw;
        if (raw.startsWith('//')) {
            candidate = `https:${raw}`;
        } else if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && /^[^\s/?#]+\.[^\s]+/.test(raw)) {
            candidate = `https://${raw}`;
        }
        const parsed = new URL(candidate);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        return candidate;
    } catch {
        return '';
    }
}

// 全局事件委托：处理代码块复制按钮
// Guard: 顶层不触碰 document，jsdom 下某些测试在 import 后才安装全局。
if (typeof document !== 'undefined') {
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
}

const THEME_STORAGE_KEY = 'justsearch_theme';

// Mirrors AMC baseFontSize / liveArtifactsCustomFontSize ranges.
export const BASE_FONT_SIZE_MIN = 12;
export const BASE_FONT_SIZE_MAX = 24;
export const DEFAULT_BASE_FONT_SIZE = 16;
export const LIVE_ARTIFACTS_FONT_SIZE_MIN = 10;
export const LIVE_ARTIFACTS_FONT_SIZE_MAX = 32;
export const DEFAULT_LIVE_ARTIFACTS_FONT_SIZE = 16;

/**
 * URL-encode a single path segment. Shared by api/history/sidebar route builders.
 * (AMC-style route ids may contain slashes, spaces, or unicode.)
 */
export function encodePathSegment(value) {
    return encodeURIComponent(String(value ?? ''));
}

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

    // P0: 支持 light/dark/graphite/auto 四档，对齐 AMC pearl/onyx/graphite
    const VALID_THEMES = new Set(['light', 'dark', 'graphite']);
    let resolvedTheme = theme;
    if (!VALID_THEMES.has(theme)) {
        // auto 或非法值 → 跟随系统；graphite 需显式选择，不随系统自动切
        const prefersDark = typeof window !== 'undefined'
            && window.matchMedia
            && window.matchMedia('(prefers-color-scheme: dark)').matches;
        resolvedTheme = prefersDark ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    const isDarkLike = resolvedTheme === 'dark' || resolvedTheme === 'graphite';
    _updateHljsTheme(isDarkLike);

    // AMC 对齐：同步写入 #theme-variables / #live-artifact-theme-variables，避免等待外链重绘
    try {
        const themeTag = document.getElementById('theme-variables');
        if (themeTag) {
            if (resolvedTheme === 'dark') {
                themeTag.textContent = ':root{--theme-bg-primary:#0c0c0e;--theme-bg-secondary:#08080a;--theme-text-primary:#f5f5f7;--theme-bg-tertiary:#1c1c20;--theme-text-secondary:#a8a8b3;--theme-text-tertiary:#78787f;--theme-border-primary:#1e1e24;--theme-border-secondary:#2c2c34}';
            } else if (resolvedTheme === 'graphite') {
                themeTag.textContent = ':root{--theme-bg-primary:#2b2b2e;--theme-bg-secondary:#1f1f22;--theme-text-primary:#f2f2f4;--theme-bg-tertiary:#3c3c40;--theme-text-secondary:#b8b8be;--theme-text-tertiary:#88888f;--theme-border-primary:#3c3c40;--theme-border-secondary:#4c4c52}';
            } else {
                themeTag.textContent = ':root{--theme-bg-primary:#fefefe;--theme-bg-secondary:#f6f7f9;--theme-text-primary:#1a1a1f;--theme-bg-tertiary:#edeef2;--theme-text-secondary:#4a4a55;--theme-text-tertiary:#75757f;--theme-border-primary:#eaeaef;--theme-border-secondary:#d5d5dc}';
            }
        }
        const liveTag = document.getElementById('live-artifact-theme-variables');
        if (liveTag) {
            const isLight = resolvedTheme === 'light';
            liveTag.textContent = isLight
                ? ':root{--amc-live-artifact-text:#111827;--amc-live-artifact-muted:#6b7280;--amc-live-artifact-border:#e5e7eb;--amc-live-artifact-accent:#2563eb}'
                : ':root{--amc-live-artifact-text:#f4f4f5;--amc-live-artifact-muted:#a1a1aa;--amc-live-artifact-border:#27272a;--amc-live-artifact-accent:#38bdf8}';
        }
        // 揭示侧栏（首屏 hidden 兜底）
        const sb = document.getElementById('sidebar');
        if (sb) sb.style.visibility = '';
        const crit = document.getElementById('critical-theme');
        if (crit && crit.parentNode) {
            // 首帧已过，可移除阻塞用内联底色
            setTimeout(() => { try { crit.remove(); } catch {} }, 300);
        }
    } catch {}

    // AMC对齐：BroadcastChannel 跨标签同步主题（参考 AMC settingsStore BroadcastChannel）
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            const bc = new BroadcastChannel('justsearch_settings');
            bc.postMessage({ type: 'SETTINGS_UPDATED', theme });
            bc.close();
        }
    } catch {}

    // Rebuild open Live Artifact iframes so dark/light theme tokens stay readable.
    // Mirrors AMC re-injecting --amc-live-artifact-* when themeId changes.
    import('./live-artifacts.js?v=53')
        .then((mod) => {
            mod.refreshLiveArtifactPreviews({ theme: document.documentElement.getAttribute('data-theme') });
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

export function safeGetLocalStorageItem(key, fallback = '') {
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

export function safeSetLocalStorageItem(key, value) {
    try {
        localStorage.setItem(key, String(value));
    } catch {
        // Storage can be unavailable in private browsing or embedded contexts.
    }
}
