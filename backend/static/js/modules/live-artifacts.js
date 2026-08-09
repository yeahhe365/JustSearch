import { showToast } from './toast.js';
import { t } from './i18n.js?v=1';
import { state } from './state.js?v=5';
import {
    assignOccurrenceAttributes,
    createOccurrenceTracker,
    shouldSkipTextNode,
} from './citation-occurrences.js?v=1';
import { setFrameEvidenceContext } from './evidence-panel.js?v=5';
import { escapeHtml, getSafeUrl } from './utils.js?v=14';

const ARTIFACT_LANGUAGES = new Set(['html', 'svg']);
const SUPPORTING_LANGUAGES = new Set(['css', 'javascript', 'js']);
const LIVE_ARTIFACT_HTML_LANGUAGE = 'amc-live-artifact-html';
const LIVE_ARTIFACT_INTERACTION_LANGUAGE = 'amc-live-artifact-interaction';
const STREAM_PREVIEW_ROOT = '<div data-amc-stream-preview-root="true"></div>';
const STREAM_RENDER_EVENT = 'stream-render';
const INTERACTION_SOURCE = 'amc-live-artifact-interaction:v1';
// Allow http: so local deploy (http://127.0.0.1) and relative /static assets work.
// Sandbox has no allow-same-origin, so 'self' would not unlock parent-origin resources.
const PREVIEW_CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    "img-src http: https: data: blob:",
    "style-src 'unsafe-inline' http: https:",
    "script-src 'unsafe-inline' http: https: blob:",
    "font-src http: https: data:",
    "media-src http: https: data: blob:",
    "connect-src http: https: data: blob:",
    "worker-src blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');
const PREVIEW_CONTENT_SECURITY_POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CONTENT_SECURITY_POLICY}">`;
// Mirror AMC-WebUI preview base styles: transparent body, natural height (no 100vh lock).
// Color comes from injectPreviewTheme tokens so dark mode stays readable.
// Mirror AMC-WebUI preview base + readable defaults when Markdown is coerced into
// the iframe (tables/headings would otherwise look unstyled without .markdown-body).
const PREVIEW_BASE_STYLES = `<style data-amc-preview-base="true">
html, body {
  margin: 0;
  padding: 0;
  background: transparent !important;
  color: var(--amc-live-artifact-text, inherit);
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow-x: auto;
  overflow-y: visible !important;
  line-height: 1.65;
  font-family: inherit;
}
body > section, body > main, body > article, body > div,
body > [data-amc-stream-preview-root],
body > [data-justsearch-live-artifact-root] {
  height: auto !important;
  max-height: none !important;
  min-height: 0 !important;
  overflow: visible !important;
}
h1,h2,h3,h4,h5,h6 {
  color: var(--amc-live-artifact-text, inherit);
  line-height: 1.35;
  margin: 0.85em 0 0.45em;
  font-weight: 700;
}
h1 { font-size: 1.45em; }
h2 { font-size: 1.25em; }
h3 { font-size: 1.1em; }
p, li { margin: 0.45em 0; }
a { color: var(--amc-live-artifact-accent, #2563eb); }
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.75em 0;
  font-size: 0.95em;
}
th, td {
  border: 1px solid var(--amc-live-artifact-border, rgba(0,0,0,.1));
  padding: 0.55em 0.75em;
  text-align: left;
  vertical-align: top;
}
th {
  background: var(--amc-live-artifact-surface-muted, rgba(0,0,0,.04));
  font-weight: 650;
}
tr:nth-child(even) td {
  background: var(--amc-live-artifact-surface, transparent);
}
blockquote {
  margin: 0.75em 0;
  padding: 0.35em 0 0.35em 0.9em;
  border-left: 3px solid var(--amc-live-artifact-border, rgba(0,0,0,.15));
  color: var(--amc-live-artifact-muted, inherit);
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
}
pre {
  overflow-x: auto;
  padding: 0.75em 1em;
  border-radius: 8px;
  background: var(--amc-live-artifact-surface-muted, rgba(0,0,0,.04));
  border: 1px solid var(--amc-live-artifact-border, rgba(0,0,0,.08));
}
img, svg { max-width: 100%; height: auto; }
.citation-group, sup.citation-ref { vertical-align: super; font-size: 0.75em; }
/* details/summary: natural document flow + visible disclosure marker */
details {
  display: block;
  height: auto !important;
  max-height: none !important;
  overflow: visible !important;
}
details > *:not(summary) {
  height: auto !important;
  max-height: none !important;
  overflow: visible !important;
}
summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: flex-start;
  gap: 0.45em;
}
summary::-webkit-details-marker { display: none; }
summary::marker { content: ''; }
summary::before {
  content: '▶';
  display: inline-block;
  flex: 0 0 auto;
  margin-top: 0.15em;
  font-size: 0.72em;
  line-height: 1;
  color: var(--amc-live-artifact-muted, #6b7280);
  transition: transform 0.15s ease;
}
details[open] > summary::before {
  transform: rotate(90deg);
}
</style>`;
const PREVIEW_BASE_FONT_SIZE_ATTRIBUTE = 'data-amc-live-artifact-base-font-size';
const PREVIEW_THEME_ATTRIBUTE = 'data-amc-live-artifact-theme';
// Theme tokens aligned with JustSearch :root / [data-theme="dark"] and AMC onyx/pearl.
const LIVE_ARTIFACT_THEME_PALETTES = {
    light: {
        colorScheme: 'light',
        text: '#111827',
        muted: '#6b7280',
        subtle: '#9ca3af',
        surface: '#f3f4f6',
        surfaceMuted: '#ffffff',
        border: '#e5e7eb',
        accent: '#2563eb',
        accentSurface: 'rgba(37, 99, 235, 0.12)',
        success: '#10b981',
        successSurface: 'rgba(16, 185, 129, 0.12)',
        danger: '#ef4444',
        dangerSurface: 'rgba(239, 68, 68, 0.12)',
        warning: '#f59e0b',
        warningSurface: 'rgba(245, 158, 11, 0.12)',
    },
    dark: {
        colorScheme: 'dark',
        text: '#f4f4f5',
        muted: '#a1a1aa',
        subtle: '#71717a',
        surface: '#18181b',
        surfaceMuted: '#1c1c1f',
        border: '#27272a',
        accent: '#38bdf8',
        accentSurface: 'rgba(56, 189, 248, 0.14)',
        success: '#34d399',
        successSurface: 'rgba(52, 211, 153, 0.14)',
        danger: '#f87171',
        dangerSurface: 'rgba(248, 113, 113, 0.14)',
        warning: '#fbbf24',
        warningSurface: 'rgba(251, 191, 36, 0.14)',
    },
};
const DEFAULT_LIVE_ARTIFACT_FONT_SIZE = 16;
const LIVE_ARTIFACT_FONT_SIZE_MIN = 10;
const LIVE_ARTIFACT_FONT_SIZE_MAX = 32;
// Align with AMC-WebUI ArtifactFrame height constants.
const INLINE_ARTIFACT_MIN_HEIGHT = 120;
const INLINE_ARTIFACT_DEFAULT_HEIGHT = 320;
const INLINE_ARTIFACT_MAX_HEIGHT = 50000;
const FRAME_HEIGHT_CACHE_MAX = 200;
const frameHeightCache = new Map();
const registry = new Map();

let artifactCounter = 0;
let activeArtifactId = '';
let activeArtifactKey = '';
let activeView = 'preview';
let panelState = null;
let lastDiagnosticToastAt = 0;

export function renderLiveArtifactsForMessage(container, markdownText, options = {}) {
    if (!container) return [];
    ensurePanel();

    const messageId = resolveMessageId(container, options.messageId);
    const artifactSources = normalizeArtifactSources(options.sources);
    const artifactCitations = Array.isArray(options.citations) ? options.citations : [];
    const isStreaming = Boolean(options.isStreaming);
    const liveArtifactsMode = resolveLiveArtifactsModeFlag(options);
    const interactionSpec = extractLiveArtifactInteraction(markdownText, isStreaming);
    if (interactionSpec) {
        syncRegistryForMessage(messageId, []);
        clearArtifactControls(container);
        renderLiveArtifactInteraction(container, interactionSpec);
        return [];
    }

    // AMC path: normalize → single live artifact (native HTML or coerced) → ArtifactFrame.
    // Callers (chat/ui) may pass a prebuilt inlineArtifact to avoid double extract/build.
    const inlineArtifact = options.inlineArtifact !== undefined
        ? options.inlineArtifact
        : getInlineLiveArtifact(markdownText, messageId, isStreaming, {
            suppressUnfencedInlineArtifact: Boolean(options.suppressUnfencedInlineArtifact),
            liveArtifactsMode,
        });
    if (inlineArtifact) {
        hydrateArtifactCitations(inlineArtifact, artifactSources, artifactCitations);
        syncRegistryForMessage(messageId, [inlineArtifact]);
        clearArtifactControls(container);
        renderInlineArtifactFrame(container, inlineArtifact);
        renderLiveArtifactSources(container, inlineArtifact, artifactSources);
        return [inlineArtifact];
    }

    const artifacts = extractLiveArtifacts(
        normalizePreviewableMarkdownContent(markdownText, { isStreaming }),
        messageId,
    );
    artifacts.forEach(artifact => hydrateArtifactCitations(artifact, artifactSources, artifactCitations));
    syncRegistryForMessage(messageId, artifacts);
    clearArtifactControls(container);

    if (artifacts.length === 0) {
        if (activeArtifactKey.startsWith(`${messageId}:`)) {
            closeLiveArtifactsPanel();
        }
        return [];
    }

    renderArtifactStrip(container, artifacts, Boolean(options.isStreaming));
    const codeBlocks = Array.from(container.querySelectorAll('pre.code-block-wrapper'));
    decorateCodeBlocks(codeBlocks, artifacts);
    hideSupportingCodeBlocks(codeBlocks, artifacts);

    if (activeArtifactKey) {
        const liveArtifact = artifacts.find(artifact => artifact.key === activeArtifactKey);
        if (liveArtifact) {
            registry.set(liveArtifact.id, liveArtifact);
            activeArtifactId = liveArtifact.id;
            renderPanel(liveArtifact);
        }
    }

    return artifacts;
}

/**
 * Resolve a single inline Live Artifact for a message.
 * When liveArtifactsMode is on (AMC Live Artifacts path), Markdown / mixed
 * answers are coerced into one themed HTML fragment so they never render as
 * clipped raw HTML inside the chat bubble.
 */
export function getInlineLiveArtifact(markdownText, messageId = 'message', isStreaming = false, options = {}) {
    const liveArtifactsMode = resolveLiveArtifactsModeFlag(options);
    const suppressUnfenced = Boolean(options.suppressUnfencedInlineArtifact);
    // AMC bare-HTML → fence wrap must NOT run when we intentionally suppress
    // unfenced artifacts (mode off + citation sources → bubble Markdown path).
    // Otherwise normalize would re-fence the HTML and bypass suppress.
    const textForExtract = (liveArtifactsMode || !suppressUnfenced)
        ? normalizePreviewableMarkdownContent(markdownText, { isStreaming })
        : String(markdownText || '');
    const native = extractInlineLiveArtifact(textForExtract, messageId, isStreaming, options);
    if (native) {
        native.code = sanitizeClippingStylesInHtml(native.code);
        if (native.streamHtml) {
            native.streamHtml = sanitizeClippingStylesInHtml(native.streamHtml);
        }
        native.srcdoc = buildSrcdoc(
            resolveArtifactPreviewCode(native),
            native.language,
            [],
            { frameId: native.id },
        );
        return native;
    }
    if (liveArtifactsMode) {
        const forCoerce = normalizePreviewableMarkdownContent(markdownText, { isStreaming });
        return coerceLiveModeArtifact(forCoerce, messageId, { isStreaming });
    }
    return null;
}

function resolveLiveArtifactsModeFlag(options = {}) {
    // Only honor an explicit boolean. A caller that forwards an optional field
    // as {liveArtifactsMode: undefined} should fall back to the global state
    // value rather than silently disabling Live Artifacts rendering.
    if (typeof options.liveArtifactsMode === 'boolean') {
        return options.liveArtifactsMode;
    }
    return Boolean(state?.liveArtifactsMode);
}

/**
 * Rebuild all open Live Artifact previews with current font size + theme tokens.
 * Call after theme switch so dark mode text/surface tokens stay readable.
 */
export function refreshLiveArtifactPreviews(settings) {
    const fontSize = resolveLiveArtifactFontSizePx(settings);
    const themeId = resolveLiveArtifactThemeId(settings);
    registry.forEach((artifact) => {
        if (!artifact?.renderable) return;
        const sources = Array.isArray(artifact.sources) ? artifact.sources : [];
        const previewCode = resolveArtifactPreviewCode(artifact);
        artifact.srcdoc = buildSrcdoc(previewCode, artifact.language, sources, {
            frameId: artifact.id,
            baseFontSize: fontSize,
            themeId,
        });
    });

    // Refresh only mounted frames. Phase 2.1 forbids swapping srcdoc on a live
    // iframe (that navigates → blank window), so push the freshly-processed
    // content over postMessage with the new theme instead. Off-screen frames were
    // unmounted (Phase 2.2); their registry srcdoc is already updated and they
    // rebuild with the new values when they scroll back into view.
    document.querySelectorAll('.live-artifact-inline-iframe').forEach((frame) => {
        const frameId = frame.dataset.liveArtifactFrameId || '';
        const artifact = frameId ? registry.get(frameId) : null;
        if (artifact) {
            const html = artifact.isStreaming
                ? (artifact.streamHtml || artifact.code || '')
                : (artifact.code || '');
            if (html) {
                postInlineArtifactStream(frame, html, { streaming: !artifact.isStreaming });
            }
        }
    });

    if (panelState?.frame && activeArtifactId) {
        const active = registry.get(activeArtifactId);
        if (active?.renderable && active.srcdoc) {
            syncPendingStreamToFrame(panelState.frame, active);
        }
    }
}

/**
 * Resolve the HTML body baked into iframe srcdoc.
 *
 * While streaming: always use a stable empty shell. Chunk content is pushed via
 * postMessage `stream-render` so the iframe does not fully reload every rAF.
 * When the stream ends (or for history): bake the real markup into srcdoc.
 */
function resolveArtifactPreviewCode(artifact) {
    if (artifact?.isStreaming) {
        return STREAM_PREVIEW_ROOT;
    }
    return artifact?.code || '';
}

function resolveLiveArtifactFontSizePx(settings) {
    const candidate = settings?.live_artifacts_font_size
        ?? state?.settings?.live_artifacts_font_size;
    if (candidate !== undefined && candidate !== null && candidate !== '') {
        return clampLiveArtifactFontSize(candidate);
    }
    if (typeof document !== 'undefined' && document.documentElement) {
        try {
            const cssValue = getComputedStyle(document.documentElement)
                .getPropertyValue('--js-live-artifacts-font-size')
                .trim();
            const cssMatch = cssValue.match(/^(\d+(?:\.\d+)?)px$/i);
            if (cssMatch) {
                return clampLiveArtifactFontSize(cssMatch[1]);
            }
        } catch {
            // getComputedStyle can fail outside a browser document.
        }
    }
    return DEFAULT_LIVE_ARTIFACT_FONT_SIZE;
}

function clampLiveArtifactFontSize(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_LIVE_ARTIFACT_FONT_SIZE;
    return Math.min(
        LIVE_ARTIFACT_FONT_SIZE_MAX,
        Math.max(LIVE_ARTIFACT_FONT_SIZE_MIN, Math.round(parsed)),
    );
}

function resolveMessageId(container, requestedId = '') {
    if (requestedId) {
        container.dataset.liveArtifactsMessageId = requestedId;
        return requestedId;
    }
    if (container.dataset.liveArtifactsMessageId) {
        return container.dataset.liveArtifactsMessageId;
    }
    artifactCounter += 1;
    const generated = `message-${artifactCounter}`;
    container.dataset.liveArtifactsMessageId = generated;
    return generated;
}

function extractLiveArtifacts(markdownText, messageId) {
    const blocks = extractCodeBlocks(markdownText);
    const rawHtmlArtifacts = extractRawHtmlArtifacts(markdownText, messageId);
    if (blocks.length === 0) return rawHtmlArtifacts;

    const cssBlocks = blocks.filter(block => block.language === 'css');
    const jsBlocks = blocks.filter(block => block.language === 'javascript' || block.language === 'js');
    const artifacts = [];

    blocks.forEach((block) => {
        const artifact = createArtifactFromBlock(block, {
            messageId,
            cssBlocks,
            jsBlocks,
            ordinal: artifacts.length,
        });
        if (artifact) artifacts.push(artifact);
    });

    return [...artifacts, ...rawHtmlArtifacts];
}

function extractInlineLiveArtifact(markdownText, messageId, isStreaming, options = {}) {
    const text = String(markdownText || '').trim();
    if (!text) return null;

    const singleFence = extractSingleLiveArtifactFence(text);
    if (singleFence) {
        return createInlineArtifact(singleFence.code, messageId, {
            isStreaming,
            language: singleFence.language === 'svg' ? 'svg' : 'html',
        });
    }

    const streamingFence = isStreaming ? extractStreamingLiveArtifactFence(text) : null;
    if (streamingFence) {
        return createInlineArtifact(streamingFence.code, messageId, {
            isStreaming,
            language: streamingFence.language === 'svg' ? 'svg' : 'html',
        });
    }

    const unfenced = stripFencedCodeBlocks(text).trim();
    if (!unfenced || unfenced !== text) return null;

    if (
        !options.suppressUnfencedInlineArtifact
        && (isStandaloneHtmlArtifact(unfenced) || (isStreaming && isLikelyStreamingHtmlArtifact(unfenced)))
    ) {
        return createInlineArtifact(unfenced, messageId, {
            isStreaming,
            language: /^<svg[\s>]/i.test(unfenced) ? 'svg' : 'html',
        });
    }

    return null;
}

// --- AMC-aligned previewable markdown normalization (previewableMarkdown.ts) ---

const MISLABELED_HTML_FRAGMENT_LANGUAGES = new Set(['css', 'text', 'txt', 'markdown', 'md']);
const HTML_STRUCTURAL_BLANK_LINE_RE = new RegExp(
    `\\n[ \\t]*\\n(?=[ \\t]*(?:<!--|<\\/?(?:article|aside|blockquote|button|caption|details|div|figure|figcaption|footer|form|h[1-6]|header|label|li|main|meter|nav|ol|p|progress|section|select|span|summary|table|tbody|td|tfoot|th|thead|tr|ul)(?:\\s|>|/)))`,
    'gi',
);
const FENCED_CODE_BLOCK_GLOBAL_RE = /```([^\n`]*)\n?([\s\S]*?)```/g;
const OPEN_FENCED_CODE_BLOCK_AT_END_RE = /```([^\n`]*)\n?([\s\S]*)$/;
const ARTIFACT_ROOT_STYLE =
    'display:block;width:100%;box-sizing:border-box;max-width:100%;overflow-wrap:anywhere;background:transparent;height:auto;max-height:none;overflow:visible;';

/**
 * AMC normalizePreviewableMarkdownContent:
 * unwrap mislabeled fences, normalize raw fragments, wrap bare HTML as artifact fence.
 */
export function normalizePreviewableMarkdownContent(markdownContent, options = {}) {
    const raw = String(markdownContent || '');
    if (!raw.trim()) return raw;
    return wrapBareLiveArtifactInteraction(
        wrapBarePreviewableArtifact(
            normalizeStandaloneRawHtmlFragment(unwrapMislabeledHtmlFragmentCodeBlocks(raw)),
            options,
        ),
        options,
    );
}

function unwrapMislabeledHtmlFragmentCodeBlocks(markdownContent) {
    if (!markdownContent) return markdownContent;
    const closed = markdownContent.replace(
        FENCED_CODE_BLOCK_GLOBAL_RE,
        (match, rawLanguage = '', rawContent = '') => {
            const language = normalizeLanguage(rawLanguage);
            const content = String(rawContent || '').trim();
            if (MISLABELED_HTML_FRAGMENT_LANGUAGES.has(language) && isStandaloneHtmlFragment(content)) {
                return content;
            }
            return match;
        },
    );
    return closed.replace(
        OPEN_FENCED_CODE_BLOCK_AT_END_RE,
        (match, rawLanguage = '', rawContent = '') => {
            const language = normalizeLanguage(rawLanguage);
            const content = String(rawContent || '').trim();
            if (
                MISLABELED_HTML_FRAGMENT_LANGUAGES.has(language)
                && isLikelyStreamingHtmlArtifact(content)
            ) {
                return content;
            }
            return match;
        },
    );
}

function normalizeStandaloneRawHtmlFragment(markdownContent) {
    const content = String(markdownContent || '').trim();
    if (
        !isStandaloneHtmlFragment(content)
        && !isLikelyStreamingHtmlArtifact(content)
    ) {
        return markdownContent;
    }
    return content.replace(HTML_STRUCTURAL_BLANK_LINE_RE, '\n');
}

function wrapBarePreviewableArtifact(markdownContent, options = {}) {
    const content = String(markdownContent || '').trim();
    if (!content) return markdownContent;
    const markupType =
        (isStandaloneHtmlArtifact(content) && (/^<svg[\s>]/i.test(content) ? 'svg' : 'html'))
        || (options.isStreaming && isLikelyStreamingHtmlArtifact(content) ? 'html' : null);
    if (!markupType) return markdownContent;
    // Already a single live-artifact fence
    if (extractSingleLiveArtifactFence(content) || extractStreamingLiveArtifactFence(content)) {
        return markdownContent;
    }
    const language = markupType === 'svg' ? 'svg' : LIVE_ARTIFACT_HTML_LANGUAGE;
    return `\`\`\`${language}\n${content}\n\`\`\``;
}

function wrapBareLiveArtifactInteraction(markdownContent, options = {}) {
    const content = String(markdownContent || '').trim();
    if (!content) return markdownContent;
    if (extractLiveArtifactInteraction(content, Boolean(options.isStreaming))) {
        // Already recognized (fenced or bare JSON handled by extractor); if bare JSON, wrap.
        if (content.startsWith('```')) return markdownContent;
        if (content.startsWith('{') && content.includes('"instruction"') && content.includes('"schema"')) {
            return `\`\`\`${LIVE_ARTIFACT_INTERACTION_LANGUAGE}\n${content}\n\`\`\``;
        }
    }
    return markdownContent;
}

/**
 * When Live Artifacts mode is on but the model returned Markdown / mixed HTML,
 * coerce into one root HTML fragment for ArtifactFrame (AMC-style single preview).
 */
function coerceLiveModeArtifact(markdownText, messageId, { isStreaming = false } = {}) {
    const text = String(markdownText || '').trim();
    if (!text) return null;

    // Prefer native HTML path after soft multi-root wrap.
    if (prefersHtmlArtifactPath(text)) {
        const wrapped = wrapAsArtifactRoot(sanitizeClippingStylesInHtml(text));
        return createInlineArtifact(wrapped, messageId, {
            isStreaming,
            language: 'html',
            coerced: true,
            coercedFrom: 'html',
        });
    }

    // Markdown / mixed prose → HTML → themed iframe (avoids parent-page clip + missing theme vars).
    const rendered = renderMarkdownHtmlForArtifact(text);
    if (!rendered.trim()) return null;
    const wrapped = wrapAsArtifactRoot(sanitizeClippingStylesInHtml(rendered));
    return createInlineArtifact(wrapped, messageId, {
        isStreaming,
        language: 'html',
        coerced: true,
        coercedFrom: 'markdown',
    });
}

function prefersHtmlArtifactPath(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (isStandaloneHtmlArtifact(t) || isLikelyStreamingHtmlArtifact(t)) return true;
    const tagMatches = t.match(/<\/?[a-zA-Z][a-zA-Z0-9:-]*\b[^>]*>/g) || [];
    const mdSignals = t.match(/^#{1,6}\s|^\|.+\||^\s{0,3}[-*+]\s|^\s{0,3}\d+\.\s/gm) || [];
    if (t.startsWith('<') && tagMatches.length >= 2) return true;
    // Substantial HTML mixed into the answer should still go through the iframe.
    if (tagMatches.length >= 6 && tagMatches.length >= mdSignals.length) return true;
    return false;
}

function wrapAsArtifactRoot(html) {
    const inner = String(html || '').trim();
    if (!inner) return '';
    if (/data-justsearch-live-artifact-root\s*=/.test(inner)) return inner;
    return `<div data-justsearch-live-artifact-root="true" style="${ARTIFACT_ROOT_STYLE}">${inner}</div>`;
}

// Cache markdown-it across stream frames (factory identity invalidates on test reinstall).
let markdownItForArtifact = null;
let markdownItForArtifactFactory = null;

function getMarkdownItForArtifact() {
    if (typeof window === 'undefined' || typeof window.markdownit !== 'function') {
        return null;
    }
    const factory = window.markdownit;
    if (markdownItForArtifact && markdownItForArtifactFactory === factory) {
        return markdownItForArtifact;
    }
    markdownItForArtifactFactory = factory;
    markdownItForArtifact = factory({
        html: true,
        linkify: true,
        typographer: true,
        breaks: false,
    });
    return markdownItForArtifact;
}

function renderMarkdownHtmlForArtifact(markdownText) {
    const text = String(markdownText || '');
    try {
        const mi = getMarkdownItForArtifact();
        if (mi) {
            let html = mi.render(text);
            if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
                // Keep style/class so model HTML mixed into MD survives; scripts stay forbidden.
                html = window.DOMPurify.sanitize(html, {
                    ADD_ATTR: ['target', 'style', 'class', 'colspan', 'rowspan', 'id'],
                    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
                    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
                });
            }
            return html;
        }
    } catch {
        // fall through
    }
    return `<pre style="white-space:pre-wrap;margin:0;">${escapeHtml(text)}</pre>`;
}


/**
 * Force every <details> open in preview HTML so collapsible secondary content is
 * visible inside fixed-height iframes without relying on postMessage resize.
 * Users can still collapse sections; height starts at the fully-open measure.
 */
function forceOpenAllDetailsInHtml(html) {
    const raw = String(html || '');
    // Match a real <details> tag name end (space, attribute, '/', or '>') so custom
    // elements like <details-panel> are not corrupted into <details open-panel>.
    if (!raw || !/<details(?:\s|\/>|>)/i.test(raw)) return raw;
    return raw.replace(/<details(?=\s|\/>|>)(?![^>]*\bopen\b)/gi, '<details open');
}

/**
 * AMC / bridge-aligned: neutralize fixed-viewport shells that clip content
 * (height:100vh, overflow:hidden on content shells).
 */
function sanitizeClippingStylesInHtml(html) {
    const raw = String(html || '');
    if (!raw || !/style\s*=/i.test(raw)) return raw;

    const rewriteStyle = (styleValue) => {
        let next = String(styleValue || '');
        next = next
            .replace(/(^|;)\s*max-height\s*:\s*(?:100vh|100dvh|100svh|100lvh|100%)\s*/gi, '$1max-height:none')
            .replace(/(^|;)\s*height\s*:\s*(?:100vh|100dvh|100svh|100lvh|100%)\s*/gi, '$1height:auto')
            .replace(/(^|;)\s*min-height\s*:\s*(?:100vh|100dvh|100svh|100lvh|100%)\s*/gi, '$1min-height:0')
            // Only neutralize *clipping* (overflow:hidden) shells — the common "thin
            // gray bar" failure. Leave overflow-y:auto/scroll intact so artifacts with
            // intentional scroll containers keep working.
            .replace(/(^|;)\s*overflow-y\s*:\s*hidden\s*/gi, '$1overflow-y:visible')
            .replace(/(^|;)\s*overflow\s*:\s*hidden\s*/gi, '$1overflow:visible');
        return next;
    };

    // Attribute rewrite without full DOM when possible (works in Node tests too).
    return raw.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (match, _q, doubleVal, singleVal) => {
        const value = doubleVal !== undefined ? doubleVal : singleVal;
        const rewritten = rewriteStyle(value);
        if (rewritten === value) return match;
        const quote = doubleVal !== undefined ? '"' : "'";
        return ` style=${quote}${rewritten}${quote}`;
    });
}

function extractSingleLiveArtifactFence(text) {
    const match = text.match(/^```([^\n`]*)\n([\s\S]*?)\n?```\s*$/);
    if (!match) return null;
    const language = normalizeLanguage(match[1] || '');
    if (language !== LIVE_ARTIFACT_HTML_LANGUAGE && language !== 'html' && language !== 'svg') {
        return null;
    }
    return {
        language,
        code: String(match[2] || '').trim(),
    };
}

function extractStreamingLiveArtifactFence(text) {
    const match = text.match(/^```([^\n`]*)\n([\s\S]*)$/);
    if (!match) return null;
    const language = normalizeLanguage(match[1] || '');
    if (language !== LIVE_ARTIFACT_HTML_LANGUAGE && language !== 'html' && language !== 'svg') {
        return null;
    }
    return {
        language,
        code: String(match[2] || '').trimStart(),
    };
}

function extractLiveArtifactInteraction(markdownText, isStreaming) {
    const text = String(markdownText || '').trim();
    if (!text) return null;

    const fenced = text.match(/^```([^\n`]*)\n([\s\S]*?)\n?```\s*$/);
    const openFence = text.match(/^```([^\n`]*)\n([\s\S]*)$/);
    const language = normalizeLanguage((fenced || openFence)?.[1] || '');
    if (language !== LIVE_ARTIFACT_INTERACTION_LANGUAGE) return null;

    const content = String((fenced || openFence)?.[2] || '').trim();
    if (isStreaming && !fenced) {
        return { pending: true };
    }

    return parseLiveArtifactInteractionSpec(content);
}

function createInlineArtifact(code, messageId, {
    isStreaming = false,
    language = 'html',
    coerced = false,
    coercedFrom = '',
} = {}) {
    const rawCode = sanitizeClippingStylesInHtml(String(code || ''));
    // Streaming: stable shell in srcdoc + streamHtml for postMessage updates.
    // Final / history: bake real markup into srcdoc.
    const previewCode = isStreaming
        ? STREAM_PREVIEW_ROOT
        : (rawCode.trim() ? rawCode : '');
    const title = getArtifactTitle({ info: '', language, code: rawCode }, language, 0);
    const id = `${messageId}-inline-0`;
    return {
        id,
        key: `${messageId}:inline-0`,
        index: 0,
        blockIndex: -1,
        messageId,
        title,
        language,
        fileName: getArtifactFileName(title, language),
        code: rawCode,
        renderable: true,
        supportBlockIndices: [],
        srcdoc: buildSrcdoc(previewCode, language, [], { frameId: id }),
        inline: true,
        isStreaming,
        streamHtml: isStreaming ? rawCode : '',
        coerced: Boolean(coerced),
        coercedFrom: coercedFrom || '',
    };
}

function extractCodeBlocks(markdownText) {
    const blocks = [];
    const text = String(markdownText || '');
    const fenceRegex = /(^|\n)(`{3,}|~{3,})([^\n`~]*)\n([\s\S]*?)(?:\n\2(?=\n|$)|$)/g;
    let match;
    let blockIndex = 0;

    while ((match = fenceRegex.exec(text)) !== null) {
        const currentBlockIndex = blockIndex;
        blockIndex += 1;
        const info = String(match[3] || '').trim();
        const rawLanguage = normalizeLanguage(info.split(/\s+/)[0] || '');
        const code = String(match[4] || '').trim();
        if (!code) continue;

        blocks.push({
            blockIndex: currentBlockIndex,
            info,
            language: rawLanguage,
            code,
        });
    }

    return blocks;
}

function extractRawHtmlArtifacts(markdownText, messageId) {
    const text = stripFencedCodeBlocks(String(markdownText || ''));
    const rawHtmlRegex = /(?:<!doctype\s+html[\s\S]*?<\/html>|<html\b[\s\S]*?<\/html>)/gi;
    const artifacts = [];
    let match;

    while ((match = rawHtmlRegex.exec(text)) !== null) {
        const code = String(match[0] || '').trim();
        if (!code) continue;
        const index = artifacts.length;
        const id = `${messageId}-raw-${index}`;
        const title = getArtifactTitle({ info: '', language: 'html', code }, 'html', index);
        artifacts.push({
            id,
            key: `${messageId}:raw-${index}`,
            index,
            blockIndex: -1,
            messageId,
            title,
            language: 'html',
            fileName: getArtifactFileName(title, 'html'),
            code,
            renderable: true,
            supportBlockIndices: [],
            srcdoc: buildSrcdoc(code, 'html', [], { frameId: id }),
        });
    }

    return artifacts;
}

function stripFencedCodeBlocks(text) {
    return text.replace(/(^|\n)(`{3,}|~{3,})([^\n`~]*)\n[\s\S]*?(?:\n\2(?=\n|$)|$)/g, '\n');
}

function normalizeLanguage(language) {
    const raw = String(language || '')
        .replace(/[{}]/g, '')
        .replace(/^language-/i, '')
        .replace(/;.*$/g, '')
        .toLowerCase();
    const aliases = {
        'application/xhtml+xml': 'html',
        'image/svg+xml': 'svg',
        'text/html': 'html',
        'text/xml': 'html',
        htm: 'html',
        xhtml: 'html',
        xml: 'html',
        js: 'javascript',
        mjs: 'javascript',
        jsx: 'javascript',
        ts: 'javascript',
        tsx: 'javascript',
    };
    return aliases[raw] || raw;
}

function parseLiveArtifactInteractionSpec(content) {
    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch {
        return null;
    }

    if (!isPlainObject(parsed) || !isPlainObject(parsed.schema)) return null;
    const version = parsed.version === undefined ? 1 : parsed.version;
    if (version !== 1) return null;

    const instruction = normalizeInteractionText(parsed.instruction, 2000);
    if (!instruction) return null;

    if (parsed.schema.type !== 'object' || !isPlainObject(parsed.schema.properties)) return null;
    const entries = Object.entries(parsed.schema.properties);
    if (entries.length === 0 || entries.length > 24) return null;

    const properties = {};
    for (const [key, rawProperty] of entries) {
        if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) return null;
        const property = normalizeInteractionProperty(rawProperty);
        if (!property) return null;
        properties[key] = property;
    }

    const required = Array.isArray(parsed.schema.required)
        ? parsed.schema.required.filter(key => typeof key === 'string' && key in properties)
        : [];

    return {
        version: 1,
        instruction,
        schema: {
            type: 'object',
            properties,
            ...(required.length > 0 ? { required } : {}),
        },
        ...(normalizeInteractionText(parsed.title, 500) ? { title: normalizeInteractionText(parsed.title, 500) } : {}),
        ...(normalizeInteractionText(parsed.description, 2000) ? { description: normalizeInteractionText(parsed.description, 2000) } : {}),
        ...(normalizeInteractionText(parsed.submitLabel, 120) ? { submitLabel: normalizeInteractionText(parsed.submitLabel, 120) } : {}),
    };
}

function normalizeInteractionProperty(value) {
    if (!isPlainObject(value) || typeof value.type !== 'string') return null;
    const type = value.type.toLowerCase();
    if (!['string', 'number', 'integer', 'boolean'].includes(type)) return null;

    const property = { type };
    const title = normalizeInteractionText(value.title, 500);
    const description = normalizeInteractionText(value.description, 2000);
    const format = normalizeInteractionText(value.format, 80);
    if (title) property.title = title;
    if (description) property.description = description;
    if (format) property.format = format;

    if (value.default !== undefined) {
        if (!isInteractionValueValidForType(value.default, type)) return null;
        property.default = value.default;
    }

    if (value.enum !== undefined) {
        if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 50) return null;
        if (!value.enum.every(item => isInteractionValueValidForType(item, type))) return null;
        property.enum = value.enum.slice();
        if (Array.isArray(value.enumNames) && value.enumNames.length === value.enum.length) {
            const names = value.enumNames.map(name => normalizeInteractionText(name, 500));
            if (names.every(Boolean)) property.enumNames = names;
        }
    }

    if (typeof value.minimum === 'number' && Number.isFinite(value.minimum)) property.minimum = value.minimum;
    if (typeof value.maximum === 'number' && Number.isFinite(value.maximum)) property.maximum = value.maximum;
    if (property.minimum !== undefined && property.maximum !== undefined && property.minimum > property.maximum) return null;

    return property;
}

function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeInteractionText(value, maxLength) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return trimmed.length <= maxLength ? trimmed : '';
}

function isInteractionValueValidForType(value, type) {
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    return typeof value === 'string';
}

function createArtifactFromBlock(block, { messageId, cssBlocks, jsBlocks, ordinal }) {
    const language = inferRenderableLanguage(block);
    if (!ARTIFACT_LANGUAGES.has(language)) {
        if (!isExplicitArtifact(block)) return null;
    }

    const index = ordinal;
    const id = `${messageId}-${index}`;
    const key = `${messageId}:${index}`;
    const code = buildArtifactCode(block, language, cssBlocks, jsBlocks);
    const title = getArtifactTitle(block, language, index);
    const renderable = ARTIFACT_LANGUAGES.has(language);
    const shouldMergeSupport = shouldMergeSupportingBlocks(block, language);

    return {
        id,
        key,
        index,
        blockIndex: block.blockIndex,
        messageId,
        title,
        language: language || block.language || 'text',
        fileName: parseInfoFileName(block.info) || getArtifactFileName(title, language || block.language || 'txt'),
        code,
        renderable,
        supportBlockIndices: shouldMergeSupport
            ? [...cssBlocks, ...jsBlocks].map(supportBlock => supportBlock.blockIndex)
            : [],
        srcdoc: renderable ? buildSrcdoc(code, language, [], { frameId: id }) : '',
    };
}

function inferRenderableLanguage(block) {
    const infoLanguage = inferLanguageFromInfo(block.info);
    if (ARTIFACT_LANGUAGES.has(infoLanguage)) return infoLanguage;
    if (block.language === 'html' || block.language === 'svg') return block.language;
    if (block.language && SUPPORTING_LANGUAGES.has(block.language)) return '';

    const code = block.code.trim();
    if (/^<svg[\s>]/i.test(code)) return 'svg';
    if (isFullHtmlDocument(code) || looksLikeHtmlFragment(code)) return 'html';
    return '';
}

function isExplicitArtifact(block) {
    return /\b(?:artifact|canvas)\b/i.test(block.info || '');
}

function buildArtifactCode(block, language, cssBlocks, jsBlocks) {
    if (language !== 'html') return block.code;

    const shouldMergeSupport = shouldMergeSupportingBlocks(block, language);
    const css = shouldMergeSupport ? cssBlocks.map(item => item.code).join('\n\n') : '';
    const js = shouldMergeSupport ? jsBlocks.map(item => item.code).join('\n\n') : '';
    let html = block.code;

    if (!isFullHtmlDocument(html)) {
        html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
${css}
  </style>
</head>
<body>
${html}
  <script>
${js}
  </script>
</body>
</html>`;
        return html;
    }

    if (css && !/<\/head>/i.test(html)) {
        html = html.replace(/<html[^>]*>/i, match => `${match}\n<head><style>\n${css}\n</style></head>`);
    } else if (css) {
        html = html.replace(/<\/head>/i, `<style>\n${css}\n</style>\n</head>`);
    }

    if (js && !/<\/body>/i.test(html)) {
        html += `\n<script>\n${js}\n</script>`;
    } else if (js) {
        html = html.replace(/<\/body>/i, `<script>\n${js}\n</script>\n</body>`);
    }

    return html;
}

function isFullHtmlDocument(code) {
    return /<!doctype html|<html[\s>]/i.test(code);
}

function looksLikeHtmlFragment(code) {
    return /<\/?(?:a|article|aside|body|button|canvas|div|footer|form|h[1-6]|head|header|html|input|li|main|nav|ol|p|script|section|span|style|svg|table|tbody|td|textarea|th|thead|tr|ul)\b/i.test(code);
}

function isStandaloneHtmlArtifact(code) {
    const normalized = String(code || '').trim();
    if (!normalized) return false;
    if (/^<svg\b[\s\S]*<\/svg>$/i.test(normalized)) return true;
    if (/^(?:<!doctype\s+html\b[^>]*>\s*)?<html\b[\s\S]*<\/html>$/i.test(normalized)) return true;
    return isStandaloneHtmlFragment(normalized);
}

function isStandaloneHtmlFragment(code) {
    const normalized = String(code || '').trim();
    if (!normalized || /<(?:script|iframe|object|embed)\b/i.test(normalized)) return false;
    const withoutComments = normalized.replace(/<!--[\s\S]*?-->/g, '').trim();
    const withoutTopLevelStyles = stripTopLevelStyleBlocks(withoutComments);
    const fragmentTags = '(?:article|aside|blockquote|button|caption|details|div|figure|figcaption|footer|form|h[1-6]|header|label|li|main|meter|nav|ol|p|progress|section|select|span|summary|table|tbody|td|tfoot|th|thead|tr|ul)';
    const sameRoot = new RegExp(`^<(${fragmentTags})(?:\\s[^>]*)?>[\\s\\S]*<\\/\\1>$`, 'i');
    const container = new RegExp(`^<${fragmentTags}(?:\\s[^>]*)?>[\\s\\S]*<\\/${fragmentTags}>$`, 'i');
    return sameRoot.test(withoutTopLevelStyles) || container.test(withoutTopLevelStyles);
}

function isLikelyStreamingHtmlArtifact(code) {
    const normalized = String(code || '').trim();
    if (!normalized || /<(?:script|iframe|object|embed)\b/i.test(normalized)) return false;
    if (/^(?:<!doctype\s+html\b[^>]*>\s*)?(?:<html\b|<head\b|<body\b)/i.test(normalized)) return true;
    return /^(?:<!--[\s\S]*?-->\s*)?<(?:style|article|aside|blockquote|button|caption|details|div|figure|figcaption|footer|form|h[1-6]|header|label|li|main|meter|nav|ol|p|progress|section|select|span|summary|table|tbody|td|tfoot|th|thead|tr|ul)(?:\s[^>]*)?>/i.test(normalized);
}

function stripTopLevelStyleBlocks(code) {
    let text = String(code || '').trim();
    const styleBlock = /<style\b[^>]*>[\s\S]*?<\/style>/i;
    while (styleBlock.test(text)) {
        const next = text
            .replace(/^\s*<style\b[^>]*>[\s\S]*?<\/style>\s*/i, '')
            .replace(/\s*<style\b[^>]*>[\s\S]*?<\/style>\s*$/i, '')
            .trim();
        if (next === text) break;
        text = next;
    }
    return text;
}

function shouldMergeSupportingBlocks(block, language) {
    return language === 'html' && !isFullHtmlDocument(block.code);
}

/**
 * Unified post-processing for artifact display HTML.
 * Streaming path stays light (sanitize + normalize only); the full chain
 * (force-open details, theme rewrite, token materialize, citation linking) runs
 * once at final bake. Keep the ordering identical to the old buildSrcdoc body so
 * final-state rendering is byte-for-byte unchanged.
 */
function processArtifactHtmlForDisplay(html, { streaming = false, sources = [], themeId } = {}) {
    const resolvedTheme = themeId || resolveLiveArtifactThemeId();
    // Keep the same order as the legacy buildSrcdoc body: clip-shell neutralization
    // first, then force-open details (order is irrelevant between the two, but
    // preserve it to minimize diff risk on final-state output).
    let out = sanitizeClippingStylesInHtml(html);
    if (streaming) return out;
    out = forceOpenAllDetailsInHtml(out);
    out = adaptArtifactHtmlForTheme(out, resolvedTheme);
    out = materializeLiveArtifactThemeVars(out, resolvedTheme);
    out = linkArtifactCitationsInHtml(out, sources);
    return out;
}

function buildSrcdoc(code, language, sources = [], options = {}) {
    const frameId = String(options.frameId || '');
    const baseFontSize = options.baseFontSize !== undefined
        ? clampLiveArtifactFontSize(options.baseFontSize)
        : resolveLiveArtifactFontSizePx();
    const themeId = options.themeId !== undefined
        ? options.themeId
        : resolveLiveArtifactThemeId();
    let srcdoc;
    if (language === 'svg') {
        srcdoc = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body { margin: 0; background: transparent; color: var(--amc-live-artifact-text, inherit); }
    body { display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
    svg { max-width: 100%; height: auto; }
  </style>
</head>
<body>
${code}
</body>
</html>`;
    } else {
        // Streaming shells bake only the (empty) preview root; real content rides
        // postMessage and is processed by the light streaming path. Final-state
        // content goes through the full chain here (see processArtifactHtmlForDisplay).
        srcdoc = processArtifactHtmlForDisplay(code, { streaming: false, sources, themeId });
    }
    // Order mirrors AMC prepareHtmlPreviewSrcDoc: security → theme → font → bridge.
    return injectPreviewSecurityPolicy(
        injectPreviewBridge(
            injectPreviewBaseFontSize(
                injectPreviewTheme(injectPreviewBaseStyles(srcdoc), themeId),
                baseFontSize,
            ),
            frameId,
        ),
    );
}

/**
 * Rebuild artifact.srcdoc from source code with the live app theme.
 * Call at iframe mount so history reloads always match current data-theme.
 * Skips rebuild when theme/font/sources/preview body are unchanged (critical
 * during streaming so the stable shell does not thrash).
 */
function ensureArtifactSrcdocTheme(artifact, sources = null) {
    if (!artifact?.renderable) return artifact;
    const themeId = resolveLiveArtifactThemeId();
    const fontSize = resolveLiveArtifactFontSizePx();
    const normalizedSources = sources !== null && sources !== undefined
        ? normalizeArtifactSources(sources)
        : (Array.isArray(artifact.sources) ? artifact.sources : []);
    if (artifact.isStreaming && !String(artifact.code || '').trim() && artifact.streamHtml) {
        artifact.code = artifact.streamHtml;
    }
    const previewCode = resolveArtifactPreviewCode(artifact);
    // Signature covers everything that affects baked srcdoc. Streaming body is
    // the constant shell, so growing streamHtml does not invalidate.
    const bakeSignature = [
        artifact.id || '',
        artifact.language || '',
        themeId,
        String(fontSize),
        artifact.isStreaming ? '1' : '0',
        previewCode,
        // Non-streaming: content lives in code. Streaming shell is in previewCode.
        artifact.isStreaming ? '' : String(artifact.code || ''),
        // Sources affect citation links inside baked HTML (final / history path).
        artifact.isStreaming ? '0' : String(normalizedSources.length),
        artifact.isStreaming
            ? ''
            : normalizedSources.map((s) => `${s.id}:${s.url || ''}`).join('|'),
    ].join('\u001f');
    if (artifact._srcdocBakeSignature === bakeSignature && artifact.srcdoc) {
        return artifact;
    }
    artifact._srcdocBakeSignature = bakeSignature;
    artifact.sources = normalizedSources;
    artifact.srcdoc = buildSrcdoc(previewCode, artifact.language, normalizedSources, {
        frameId: artifact.id,
        baseFontSize: fontSize,
        themeId,
    });
    return artifact;
}

/**
 * Attach sources/citations metadata and prepare streamHtml citation links.
 * Does NOT build srcdoc — ensureArtifactSrcdocTheme is the single bake path.
 */
function hydrateArtifactCitations(artifact, sources, citations = []) {
    const normalizedSources = normalizeArtifactSources(sources);
    const normalizedCitations = Array.isArray(citations) ? citations : [];
    if (artifact) {
        artifact.sources = normalizedSources;
        artifact.citations = normalizedCitations;
        // Register per-frame evidence so iframe citation-click does not use the
        // last-rendered message's singleton context.
        if (artifact.id) {
            setFrameEvidenceContext(artifact.id, {
                sources: normalizedSources,
                citations: normalizedCitations,
            });
        }
    }
    if (!artifact?.renderable || artifact.language !== 'html' || normalizedSources.length === 0) {
        return artifact;
    }
    // Keep original artifact.code intact for copy/download; stream path links
    // citations into streamHtml so postMessage carries clickable chips.
    if (artifact.isStreaming && artifact.streamHtml) {
        artifact.streamHtml = linkArtifactCitationsInHtml(artifact.streamHtml, normalizedSources);
    }
    return artifact;
}

function linkArtifactCitationsInHtml(html, sources = []) {
    const raw = String(html || '');
    if (!/\[\d+(?:\s*,\s*\d+)*\]/.test(raw)) return raw;
    const sourceById = buildSourceMap(sources);
    if (sourceById.size === 0 || typeof document === 'undefined') return raw;

    const fullDocument = /(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(raw);
    const Parser = (typeof window !== 'undefined' && window.DOMParser) || globalThis.DOMParser;
    if (fullDocument && Parser) {
        const parsed = new Parser().parseFromString(raw, 'text/html');
        linkCitationTextNodes(parsed.body, sourceById);
        const doctype = /^\s*<!doctype\s+html\b/i.test(raw) ? '<!doctype html>\n' : '';
        return `${doctype}${parsed.documentElement.outerHTML}`;
    }

    const template = document.createElement('template');
    template.innerHTML = raw;
    linkCitationTextNodes(template.content, sourceById);
    return template.innerHTML;
}

function buildSourceMap(sources) {
    return new Map(
        normalizeArtifactSources(sources)
            .map(source => [String(source.id), source])
    );
}

function linkCitationTextNodes(root, sourceById) {
    const filter = (typeof NodeFilter !== 'undefined' && NodeFilter)
        || (typeof window !== 'undefined' && window.NodeFilter);
    if (!root || !filter) return;

    const walker = document.createTreeWalker(root, filter.SHOW_TEXT, {
        acceptNode(node) {
            if (!/\[\d+(?:\s*,\s*\d+)*\]/.test(node.textContent || '')) {
                return filter.FILTER_REJECT;
            }
            return shouldSkipTextNode(node, root) ? filter.FILTER_REJECT : filter.FILTER_ACCEPT;
        }
    });

    const nodes = [];
    while (walker.nextNode()) {
        nodes.push(walker.currentNode);
    }
    const tracker = createOccurrenceTracker();
    nodes.forEach(node => replaceCitationTextNode(node, sourceById, tracker));
}

function replaceCitationTextNode(node, sourceById, tracker) {
    const text = node.textContent || '';
    const regex = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const group = document.createElement('span');
        group.className = 'citation-group live-artifact-citation-group';
        const ids = match[1].split(',').map(id => id.trim()).filter(Boolean);
        let linkedCount = 0;
        const groupIndex = tracker.nextGroup();

        ids.forEach((id, index) => {
            const source = sourceById.get(id);
            const safeUrl = source ? getSafeUrl(source.url) : '';
            if (source && safeUrl) {
                group.appendChild(createArtifactCitationLink(id, source, safeUrl, tracker, groupIndex, index));
                linkedCount += 1;
            } else {
                group.appendChild(document.createTextNode(`[${id}]`));
            }
            if (index < ids.length - 1) {
                const comma = document.createElement('span');
                comma.textContent = ',';
                comma.setAttribute('aria-hidden', 'true');
                group.appendChild(comma);
            }
        });

        fragment.appendChild(linkedCount > 0 ? group : document.createTextNode(match[0]));
        lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    node.parentNode?.replaceChild(fragment, node);
}

function createArtifactCitationLink(id, source, safeUrl, tracker, groupIndex, markerIndex) {
    const anchor = document.createElement('a');
    anchor.href = safeUrl || '#';
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.className = 'citation-link live-artifact-citation-link';
    anchor.dataset.liveArtifactSourceUrl = safeUrl || '';
    anchor.dataset.liveArtifactSourceId = id;
    anchor.title = source.title || source.url || `Source ${id}`;
    anchor.setAttribute('aria-label', t('liveArtifacts.viewSourceEvidence', { id }));
    assignOccurrenceAttributes(anchor, tracker, id, groupIndex, markerIndex);
    // Use injected theme tokens so citation chips stay readable in dark mode.
    anchor.setAttribute('style', 'color:var(--amc-live-artifact-accent,#2563eb);text-decoration:none;cursor:pointer;margin:0 1px;font-weight:700;font-size:11px;padding:0 4px;border-radius:6px;background:var(--amc-live-artifact-accent-surface,rgba(37,99,235,.12));display:inline-flex;align-items:center;justify-content:center;vertical-align:super;line-height:16px;min-height:16px;white-space:nowrap;');
    anchor.textContent = id;
    return anchor;
}

function injectPreviewHeadStyle(srcdoc, style) {
    const code = String(srcdoc || '');
    if (!style) return code;
    if (code.includes(PREVIEW_CONTENT_SECURITY_POLICY_META)) {
        return code.replace(PREVIEW_CONTENT_SECURITY_POLICY_META, `${PREVIEW_CONTENT_SECURITY_POLICY_META}${style}`);
    }
    if (/<head\b[^>]*>/i.test(code)) {
        return code.replace(/<head\b[^>]*>/i, headTag => `${headTag}${style}`);
    }
    if (/<html\b[^>]*>/i.test(code)) {
        return code.replace(/<html\b[^>]*>/i, htmlTag => `${htmlTag}<head>${style}</head>`);
    }
    return `<!doctype html><html><head>${style}</head><body>${code}</body></html>`;
}

function injectPreviewBaseStyles(srcdoc) {
    const code = String(srcdoc || '');
    if (code.includes('data-amc-preview-base')) {
        return code;
    }
    return injectPreviewHeadStyle(code, PREVIEW_BASE_STYLES);
}

function resolveLiveArtifactThemeId(settings) {
    // Prefer the live DOM theme — matches what the user actually sees after quick toggle.
    if (typeof document !== 'undefined' && document.documentElement) {
        const attr = document.documentElement.getAttribute('data-theme');
        if (attr === 'dark' || attr === 'light') {
            return attr;
        }
    }
    const explicit = settings?.theme;
    if (explicit === 'dark' || explicit === 'light') {
        return explicit;
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        try {
            return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        } catch {
            // ignore
        }
    }
    return 'light';
}

function resolveLiveArtifactThemePalette(themeId) {
    const id = themeId === 'dark' ? 'dark' : 'light';
    return LIVE_ARTIFACT_THEME_PALETTES[id] || LIVE_ARTIFACT_THEME_PALETTES.light;
}

/**
 * Rewrite model-hardcoded light-theme colors so dark mode stays readable.
 * Models often emit color:#111 / background:#f5f5f5 while the root stays transparent;
 * theme CSS variables alone cannot override inline style attributes.
 */
function adaptArtifactHtmlForTheme(html, themeId) {
    const raw = String(html || '');
    if (!raw || themeId !== 'dark') return raw;
    if (typeof DOMParser === 'undefined') {
        return adaptArtifactStyleStringForDark(raw);
    }

    try {
        const fullDocument = /(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(raw);
        const parsed = new DOMParser().parseFromString(
            fullDocument ? raw : `<div data-amc-theme-adapt-root="true">${raw}</div>`,
            'text/html',
        );
        const scope = fullDocument
            ? parsed.documentElement
            : parsed.body.querySelector('[data-amc-theme-adapt-root="true"]') || parsed.body;

        scope.querySelectorAll('[style]').forEach((node) => {
            const next = adaptArtifactStyleStringForDark(node.getAttribute('style') || '');
            if (next) node.setAttribute('style', next);
            else node.removeAttribute('style');
        });
        scope.querySelectorAll('style').forEach((node) => {
            node.textContent = adaptArtifactStyleStringForDark(node.textContent || '');
        });

        if (fullDocument) {
            const doctype = /^\s*<!doctype\s+html\b/i.test(raw) ? '<!doctype html>\n' : '';
            return `${doctype}${parsed.documentElement.outerHTML}`;
        }
        const root = parsed.body.querySelector('[data-amc-theme-adapt-root="true"]');
        return root ? root.innerHTML : parsed.body.innerHTML;
    } catch {
        return adaptArtifactStyleStringForDark(raw);
    }
}

/**
 * Expand AMC theme tokens in artifact HTML to concrete colors for the active theme.
 * Guarantees dark mode surfaces are zinc-900 (#18181b), never unresolved light fallbacks.
 */
function materializeLiveArtifactThemeVars(html, themeId) {
    const raw = String(html || '');
    if (!raw || !raw.includes('--amc-live-artifact-')) return raw;
    const colors = resolveLiveArtifactThemePalette(themeId);
    const tokenMap = {
        '--amc-live-artifact-text': colors.text,
        '--amc-live-artifact-muted': colors.muted,
        '--amc-live-artifact-subtle': colors.subtle,
        '--amc-live-artifact-surface': colors.surface,
        '--amc-live-artifact-surface-muted': colors.surfaceMuted,
        '--amc-live-artifact-border': colors.border,
        '--amc-live-artifact-accent': colors.accent,
        '--amc-live-artifact-accent-surface': colors.accentSurface,
        '--amc-live-artifact-success': colors.success,
        '--amc-live-artifact-success-surface': colors.successSurface,
        '--amc-live-artifact-danger': colors.danger,
        '--amc-live-artifact-danger-surface': colors.dangerSurface,
        '--amc-live-artifact-warning': colors.warning,
        '--amc-live-artifact-warning-surface': colors.warningSurface,
    };
    return raw.replace(
        /var\(\s*(--amc-live-artifact-[\w-]+)\s*(?:,[^)]+)?\)/gi,
        (match, tokenName) => {
            const key = String(tokenName || '').toLowerCase();
            return tokenMap[key] || match;
        },
    );
}

function adaptArtifactStyleStringForDark(styleText) {
    const input = String(styleText || '');
    if (!input || !/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black|gray|grey)\b/i.test(input)) {
        return input;
    }

    // Match property:value in bare style attrs and full HTML/CSS snippets.
    // Includes border shorthands like "border-bottom:1px solid #ddd".
    return input.replace(
        /(^|;\s*|[\s{"'])((?:background-color|background|border-color|border-top-color|border-right-color|border-bottom-color|border-left-color|border-top|border-right|border-bottom|border-left|border|outline-color|outline|color|fill|stroke))\s*:\s*([^;{}"']+)/gi,
        (match, prefix, prop, value) => {
            const trimmed = value.trim();
            const propName = prop.trim().toLowerCase();
            const colorToken = trimmed.match(/(#[0-9a-f]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|\b(?:white|black|gray|grey)\b)/i);

            // border / border-left / outline shorthands: rewrite only the light gray color token.
            if (/^border(?:-top|-right|-bottom|-left)?$/.test(propName) || propName === 'outline') {
                if (!colorToken) return match;
                const mappedBorder = mapHardcodedColorForDarkTheme('border-color', colorToken[1]);
                if (!mappedBorder) return match;
                return `${prefix}${prop}: ${trimmed.replace(colorToken[1], mappedBorder)}`;
            }

            // Skip multi-value backgrounds like "url(...) #fff".
            if (/\burl\s*\(/i.test(trimmed) || (/\s/.test(trimmed) && !/^(rgba?|hsla?)\(/i.test(trimmed))) {
                if (!colorToken || propName !== 'background') return match;
                const mappedBg = mapHardcodedColorForDarkTheme('background-color', colorToken[1]);
                if (!mappedBg) return match;
                return `${prefix}${prop}: ${mappedBg}`;
            }

            const mapped = mapHardcodedColorForDarkTheme(propName, trimmed);
            if (!mapped) return match;
            return `${prefix}${prop}: ${mapped}`;
        },
    );
}

function mapHardcodedColorForDarkTheme(property, value) {
    const parsed = parseCssColorValue(value);
    if (!parsed) return null;

    const { r, g, b, a } = parsed;
    if (a < 0.08) return null;

    const lum = relativeLuminance(r, g, b);
    const isBg = property === 'background' || property === 'background-color';
    const isBorder = property.startsWith('border') || property === 'outline-color';
    const isText = property === 'color' || property === 'fill' || property === 'stroke';
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);

    if (isBg) {
        // Near-white / pale tinted surfaces → dark surfaces (keep a hint of hue when chromatic).
        if (lum >= 0.72) {
            if (chroma < 25) return 'var(--amc-live-artifact-surface)';
            // Pale blue/amber callouts → accent-tinted surface.
            return 'var(--amc-live-artifact-accent-surface)';
        }
        if (lum >= 0.55 && chroma < 20) return 'var(--amc-live-artifact-surface-muted)';
        return null;
    }

    if (isBorder) {
        if (lum >= 0.55) return 'var(--amc-live-artifact-border)';
        return null;
    }

    if (isText) {
        // Dark saturated brand blues/greens used as emphasis on light cards.
        if (chroma >= 40 && lum <= 0.55) return 'var(--amc-live-artifact-accent)';
        // Near-black body text (#000/#111/#333) → primary text token.
        if (lum <= 0.12 && chroma < 40) return 'var(--amc-live-artifact-text)';
        // Mid gray muted labels (#666/#888/#999).
        if (lum > 0.12 && lum < 0.65 && chroma < 30) return 'var(--amc-live-artifact-muted)';
        return null;
    }

    return null;
}

function parseCssColorValue(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw || raw.startsWith('var(') || raw === 'transparent' || raw === 'inherit' || raw === 'currentcolor') {
        return null;
    }
    if (raw === 'white') return { r: 255, g: 255, b: 255, a: 1 };
    if (raw === 'black') return { r: 0, g: 0, b: 0, a: 1 };
    if (raw === 'gray' || raw === 'grey') return { r: 128, g: 128, b: 128, a: 1 };

    const hex = raw.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
        let h = hex[1];
        if (h.length === 3 || h.length === 4) {
            h = h.split('').map((ch) => ch + ch).join('');
        }
        if (h.length === 6 || h.length === 8) {
            const r = parseInt(h.slice(0, 2), 16);
            const g = parseInt(h.slice(2, 4), 16);
            const b = parseInt(h.slice(4, 6), 16);
            const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
            if ([r, g, b].every(Number.isFinite)) return { r, g, b, a: Number.isFinite(a) ? a : 1 };
        }
        return null;
    }

    const rgb = raw.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/);
    if (rgb) {
        return {
            r: Math.min(255, Math.max(0, Number(rgb[1]))),
            g: Math.min(255, Math.max(0, Number(rgb[2]))),
            b: Math.min(255, Math.max(0, Number(rgb[3]))),
            a: rgb[4] === undefined ? 1 : Math.min(1, Math.max(0, Number(rgb[4]))),
        };
    }
    return null;
}

function relativeLuminance(r, g, b) {
    const toLinear = (c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Build injected theme CSS for Live Artifact iframes (AMC-compatible token names).
 * Transparent root + themed text, matching AMC previewDocument.buildPreviewThemeStyle.
 */
function buildPreviewThemeStyle(themeId) {
    const colors = resolveLiveArtifactThemePalette(themeId);
    // Mirror AMC: transparent html/body, tokenized text. Concrete hex also set so
    // unresolved var() never falls back to the browser's default white canvas look.
    return `<style ${PREVIEW_THEME_ATTRIBUTE}="true">:root,html{color-scheme:${colors.colorScheme};--amc-live-artifact-text:${colors.text};--amc-live-artifact-muted:${colors.muted};--amc-live-artifact-subtle:${colors.subtle};--amc-live-artifact-surface:${colors.surface};--amc-live-artifact-surface-muted:${colors.surfaceMuted};--amc-live-artifact-border:${colors.border};--amc-live-artifact-accent:${colors.accent};--amc-live-artifact-accent-surface:${colors.accentSurface};--amc-live-artifact-success:${colors.success};--amc-live-artifact-success-surface:${colors.successSurface};--amc-live-artifact-danger:${colors.danger};--amc-live-artifact-danger-surface:${colors.dangerSurface};--amc-live-artifact-warning:${colors.warning};--amc-live-artifact-warning-surface:${colors.warningSurface};}html,body{margin:0;padding:0;background:transparent!important;color:${colors.text}!important;}body{overflow-x:auto;color:${colors.text};}h1,h2,h3,h4,h5,h6,p,li,td,th,summary,label,span,a,strong,em,small,div,section,article,aside,header,footer,main,ul,ol,table{color:inherit;}</style>`;
}

function injectPreviewTheme(srcdoc, themeId) {
    const code = String(srcdoc || '');
    if (code.includes(PREVIEW_THEME_ATTRIBUTE)) {
        return code;
    }
    return injectPreviewHeadStyle(code, buildPreviewThemeStyle(themeId));
}

function buildPreviewBaseFontSizeStyle(baseFontSize) {
    const fontSize = clampLiveArtifactFontSize(baseFontSize);
    return `<style ${PREVIEW_BASE_FONT_SIZE_ATTRIBUTE}="true">:root{--amc-live-artifact-font-size:${fontSize}px;font-size:var(--amc-live-artifact-font-size);}body{font-size:var(--amc-live-artifact-font-size);}</style>`;
}

function injectPreviewBaseFontSize(srcdoc, baseFontSize) {
    const code = String(srcdoc || '');
    if (code.includes(PREVIEW_BASE_FONT_SIZE_ATTRIBUTE)) {
        return code;
    }
    return injectPreviewHeadStyle(code, buildPreviewBaseFontSizeStyle(baseFontSize));
}

function injectPreviewBridge(code, frameId = '') {
    const safeFrameId = JSON.stringify(String(frameId || ''));
    // Bridge resize mirrors AMC-WebUI previewBridgeScript:
    // body/root scrollHeight + ResizeObserver + MutationObserver.
    // JustSearch extras: frameId routing, details toggle bursts, citations, stream-render.
    const bridge = `<script>
(() => {
  const MIN_HEIGHT = ${INLINE_ARTIFACT_MIN_HEIGHT};
  const HEIGHT_PAD = 8;
  const FRAME_ID = ${safeFrameId};
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
  let isMeasuringHeight = false;
  // Keep document free of 100vh / overflow:hidden shells so scrollHeight tracks content
  // (same role as AMC theme style: body { overflow-x:auto } only).
  const neutralizeViewportLocks = () => {
    try {
      const body = document.body;
      const root = document.documentElement;
      if (root) {
        root.style.setProperty('height', 'auto', 'important');
        root.style.setProperty('min-height', '0', 'important');
        root.style.setProperty('max-height', 'none', 'important');
        root.style.setProperty('overflow-y', 'visible', 'important');
      }
      if (body) {
        body.style.setProperty('height', 'auto', 'important');
        body.style.setProperty('min-height', '0', 'important');
        body.style.setProperty('max-height', 'none', 'important');
        body.style.setProperty('overflow-y', 'visible', 'important');
        Array.from(body.children).forEach((el) => {
          if (!(el instanceof Element) || SKIP_TAGS.has(el.tagName)) return;
          el.style.setProperty('height', 'auto', 'important');
          el.style.setProperty('max-height', 'none', 'important');
          el.style.setProperty('overflow', 'visible', 'important');
        });
      }
    } catch {}
  };
  /**
   * AMC-WebUI measureContentHeight: neutralize the doc shell + every visible
   * body child, then take the max bottom rect of each visible child. This is
   * the intrinsic content height — never body/html offsetHeight (those equal
   * the iframe viewport once the parent sets a fixed height, causing a ratchet
   * that leaves large blank regions under short content and clips tall content).
   */
  const measureContentHeight = () => {
    const body = document.body;
    const root = document.documentElement;
    if (!body || !root) return MIN_HEIGHT;

    const restored = [];
    const neutralizeSize = (el) => {
      if (!(el instanceof HTMLElement)) return;
      restored.push([el, el.style.height, el.style.minHeight, el.style.maxHeight]);
      el.style.setProperty('height', 'auto', 'important');
      el.style.setProperty('min-height', '0', 'important');
      el.style.setProperty('max-height', 'none', 'important');
    };

    isMeasuringHeight = true;
    try {
      neutralizeSize(root);
      neutralizeSize(body);
      Array.from(body.children).forEach((el) => {
        if (!(el instanceof HTMLElement)) return;
        if (SKIP_TAGS.has(el.tagName)) return;
        neutralizeSize(el);
      });

      const scrollY = window.pageYOffset || root.scrollTop || body.scrollTop || 0;
      let contentBottom = 0;
      const visit = (el) => {
        if (!(el instanceof Element) || SKIP_TAGS.has(el.tagName)) return;
        let style;
        try { style = window.getComputedStyle(el); } catch {}
        if (style) {
          if (style.display === 'none' || style.visibility === 'hidden') return;
          if (style.position === 'fixed') return; // viewport-relative, must not inflate height
        }
        const rect = el.getBoundingClientRect();
        if (!rect || (rect.height === 0 && rect.width === 0 && el.childElementCount === 0)) return;
        let marginBottom = 0;
        try { marginBottom = parseFloat(style.marginBottom) || 0; } catch {}
        contentBottom = Math.max(contentBottom, rect.bottom + scrollY + marginBottom);
      };
      Array.from(body.children).forEach(visit);
      // Open details content is often deeper than body.children alone reports.
      document.querySelectorAll('details[open]').forEach((details) => {
        visit(details);
        Array.from(details.children).forEach(visit);
      });

      const bodyStyle = window.getComputedStyle(body);
      const paddingBottom = parseFloat(bodyStyle.paddingBottom) || 0;
      const borderBottom = parseFloat(bodyStyle.borderBottomWidth) || 0;

      if (contentBottom > 0) {
        return Math.max(
          MIN_HEIGHT,
          Math.ceil(contentBottom + paddingBottom + borderBottom + HEIGHT_PAD),
        );
      }
      // Empty/sparse documents: fall back to scrollHeight only (not offsetHeight).
      return Math.max(
        MIN_HEIGHT,
        Math.ceil((body.scrollHeight || 0) + HEIGHT_PAD),
        Math.ceil((root.scrollHeight || 0) + HEIGHT_PAD),
      );
    } catch {
      return MIN_HEIGHT;
    } finally {
      for (let i = restored.length - 1; i >= 0; i -= 1) {
        const [el, height, minHeight, maxHeight] = restored[i];
        el.style.height = height;
        el.style.minHeight = minHeight;
        el.style.maxHeight = maxHeight;
      }
      isMeasuringHeight = false;
    }
  };
  const notifyResize = (extra = {}) => {
    try {
      const height = measureContentHeight();
      const openDetailsCount = document.querySelectorAll('details[open]').length;
      const totalDetailsCount = document.querySelectorAll('details').length;
      parent.postMessage({
        channel: 'justsearch-live-artifacts',
        event: 'resize',
        height,
        frameId: FRAME_ID,
        openDetailsCount,
        totalDetailsCount,
        detailsOpen: openDetailsCount > 0,
        ...extra,
      }, '*');
    } catch {}
  };
  let resizeScheduled = false;
  const scheduleResize = () => {
    if (isMeasuringHeight || resizeScheduled) return;
    resizeScheduled = true;
    // AMC uses a single rAF; double-rAF helps details layout commit before measure.
    const done = () => {
      // Guard: rAF and setTimeout can both fire; whichever arrives first wins,
      // the other becomes a no-op (resizeScheduled is only reset here).
      if (!resizeScheduled) return;
      resizeScheduled = false;
      if (isMeasuringHeight) return;
      notifyResize();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(done));
    } else {
      done();
    }
    // rAF is suspended in background tabs (and during long tasks), so a
    // setTimeout fallback guarantees the resize message is always emitted —
    // otherwise the parent viewport stays at the (too-small) seed height and
    // the bottom of the artifact is clipped permanently.
    setTimeout(done, 120);
  };
  const scheduleResizeBurst = () => {
    scheduleResize();
    setTimeout(notifyResize, 0);
    setTimeout(notifyResize, 50);
    setTimeout(notifyResize, 120);
    setTimeout(notifyResize, 300);
  };
  const notifyReady = () => {
    try {
      parent.postMessage({ channel: 'justsearch-live-artifacts', event: 'ready', frameId: FRAME_ID }, '*');
    } catch {}
    scheduleResizeBurst();
  };
  // Citation chips open the parent evidence panel instead of navigating away.
  document.addEventListener('click', (event) => {
    try {
      const anchor = event.target && event.target.closest
        ? event.target.closest('a.live-artifact-citation-link, a.citation-link')
        : null;
      if (!anchor) return;
      const sourceId = anchor.getAttribute('data-live-artifact-source-id')
        || anchor.getAttribute('data-evidence-source-id')
        || (anchor.textContent || '').trim();
      if (!sourceId) return;
      event.preventDefault();
      event.stopPropagation();
      parent.postMessage({
        channel: 'justsearch-live-artifacts',
        event: 'citation-click',
        sourceId: sourceId,
        occurrenceId: anchor.getAttribute('data-evidence-occurrence-id') || '',
        occurrenceIndex: anchor.getAttribute('data-evidence-occurrence-index') || '',
        groupIndex: anchor.getAttribute('data-evidence-group-index') || '',
        markerIndex: anchor.getAttribute('data-evidence-marker-index') || '',
        markerOccurrenceIndex: anchor.getAttribute('data-evidence-marker-occurrence-index') || '',
        url: anchor.getAttribute('data-live-artifact-source-url') || anchor.href || '',
        title: anchor.getAttribute('title') || '',
        frameId: FRAME_ID,
      }, '*');
    } catch {}
  }, true);
  const notifyDiagnostic = (payload) => {
    try {
      parent.postMessage({ channel: 'justsearch-live-artifacts', event: 'diagnostic', payload }, '*');
    } catch {}
  };
  const readResourceUrl = (element) => {
    if (!(element instanceof Element)) return undefined;
    return element.getAttribute('src') || element.getAttribute('href') || element.getAttribute('poster') || undefined;
  };
  const reportResourceError = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    if (!['img', 'script', 'link', 'video', 'audio', 'source'].includes(tagName)) return false;
    notifyDiagnostic({
      type: 'resource-error',
      tagName,
      url: readResourceUrl(target),
    });
    return true;
  };
  window.addEventListener('error', (event) => {
    if (reportResourceError(event)) return;
    notifyDiagnostic({
      type: 'runtime-error',
      message: event.message || 'Unknown Live Artifact runtime error',
      source: event.filename || undefined,
      line: event.lineno || undefined,
      column: event.colno || undefined,
    });
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    notifyDiagnostic({
      type: 'runtime-error',
      message: reason && typeof reason.message === 'string'
        ? reason.message
        : String(reason || 'Unhandled promise rejection'),
    });
  });
  window.addEventListener('securitypolicyviolation', (event) => {
    notifyDiagnostic({
      type: 'csp-violation',
      blockedURI: event.blockedURI,
      violatedDirective: event.violatedDirective,
      effectiveDirective: event.effectiveDirective,
    });
  });
  if (document.readyState === 'complete') {
    Promise.resolve().then(notifyReady);
  } else {
    window.addEventListener('load', notifyReady, { once: true });
  }
  window.addEventListener('resize', scheduleResize);
  // details[open] is the common failure: body border-box may not change while content grows
  // past the fixed iframe viewport, so ResizeObserver alone is insufficient.
  const notifyDetailsToggle = (details) => {
    if (!(details instanceof HTMLDetailsElement)) return;
    const openCount = document.querySelectorAll('details[open]').length;
    const totalCount = document.querySelectorAll('details').length;
    // Immediate + delayed remeasures; parent also has precomputed expanded height fallback.
    notifyResize({
      detailsToggle: true,
      detailsOpen: Boolean(details.open),
      openDetailsCount: openCount,
      totalDetailsCount: totalCount,
    });
    scheduleResizeBurst();
    setTimeout(() => {
      notifyResize({
        detailsToggle: true,
        detailsOpen: Boolean(details.open),
        openDetailsCount: document.querySelectorAll('details[open]').length,
        totalDetailsCount: document.querySelectorAll('details').length,
      });
    }, 80);
    setTimeout(() => {
      notifyResize({
        detailsToggle: true,
        detailsOpen: Boolean(details.open),
        openDetailsCount: document.querySelectorAll('details[open]').length,
        totalDetailsCount: document.querySelectorAll('details').length,
      });
    }, 320);
  };
  document.addEventListener('toggle', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLDetailsElement)) return;
    notifyDetailsToggle(target);
  }, true);
  document.addEventListener('click', (event) => {
    try {
      const summary = event.target && event.target.closest
        ? event.target.closest('summary')
        : null;
      if (!summary) return;
      const details = summary.closest('details');
      // Click can fire before open flips; remeasure after the engine commits state.
      setTimeout(() => notifyDetailsToggle(details || summary.parentElement), 0);
      setTimeout(() => notifyDetailsToggle(details || summary.parentElement), 50);
    } catch {}
  }, true);
  // AMC-WebUI: observe documentElement + body size and any DOM mutation.
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(scheduleResize);
    if (document.documentElement) observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
  }
  if ('MutationObserver' in window) {
    const observer = new MutationObserver(scheduleResize);
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  }
  const sanitizeStreamDocument = (parsedDocument) => {
    parsedDocument.querySelectorAll('script, iframe, object, embed').forEach((node) => node.remove());
    parsedDocument.querySelectorAll('*').forEach((node) => {
      Array.from(node.attributes).forEach((attribute) => {
        if (/^on/i.test(attribute.name) || attribute.name === 'srcdoc') node.removeAttribute(attribute.name);
      });
    });
  };
  // AMC-WebUI streamingPreviewRunnerScript: incremental patch. First render
  // replaces the root wholesale; later stream updates patch node-by-node so
  // existing DOM state (focus, scroll, expanded <details>) survives. The prior
  // replaceChildren rebuild destroyed that state on every chunk and could flash
  // on fast updates.
  const syncAttributes = (currentElement, nextElement) => {
    Array.from(currentElement.attributes).forEach((attribute) => {
      if (!nextElement.hasAttribute(attribute.name)) {
        currentElement.removeAttribute(attribute.name);
      }
    });
    Array.from(nextElement.attributes).forEach((attribute) => {
      if (currentElement.getAttribute(attribute.name) !== attribute.value) {
        currentElement.setAttribute(attribute.name, attribute.value);
      }
    });
  };
  const canPatchNode = (currentNode, nextNode) => {
    if (currentNode.nodeType !== nextNode.nodeType) return false;
    if (currentNode.nodeType === Node.ELEMENT_NODE) {
      return currentNode.nodeName === nextNode.nodeName;
    }
    return true;
  };
  const patchNode = (currentNode, nextNode) => {
    if (!canPatchNode(currentNode, nextNode)) {
      currentNode.replaceWith(nextNode);
      return;
    }
    if (currentNode.nodeType === Node.TEXT_NODE) {
      if (currentNode.nodeValue !== nextNode.nodeValue) {
        currentNode.nodeValue = nextNode.nodeValue;
      }
      return;
    }
    if (currentNode.nodeType !== Node.ELEMENT_NODE) {
      currentNode.replaceWith(nextNode);
      return;
    }
    syncAttributes(currentNode, nextNode);
    patchChildren(currentNode, nextNode);
  };
  const patchChildren = (currentParent, nextParent) => {
    const currentChildren = Array.from(currentParent.childNodes);
    const nextChildren = Array.from(nextParent.childNodes);
    const maxLength = Math.max(currentChildren.length, nextChildren.length);
    for (let index = 0; index < maxLength; index += 1) {
      const currentChild = currentChildren[index];
      const nextChild = nextChildren[index];
      if (!nextChild) {
        currentChild.remove();
        continue;
      }
      if (!currentChild) {
        currentParent.appendChild(nextChild);
        continue;
      }
      patchNode(currentChild, nextChild);
    }
  };
  const buildRenderableFragment = (parsedDocument) => {
    const fragment = document.createDocumentFragment();
    parsedDocument.head.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
      fragment.appendChild(document.importNode(node, true));
    });
    Array.from(parsedDocument.body.childNodes).forEach((node) => {
      fragment.appendChild(document.importNode(node, true));
    });
    return fragment;
  };
  const renderStreamHtml = (html) => {
    const root = document.querySelector('[data-amc-stream-preview-root]');
    if (!root || typeof html !== 'string') return;
    const parser = new DOMParser();
    const parsedDocument = parser.parseFromString(html, 'text/html');
    sanitizeStreamDocument(parsedDocument);
    const fragment = buildRenderableFragment(parsedDocument);
    if (!root.hasChildNodes()) {
      root.replaceChildren(fragment);
    } else {
      patchChildren(root, fragment);
    }
    scheduleResize();
  };
  // Coalesce bursty stream-render messages: the parent throttles to ~120ms but
  // can still fire several in quick succession (or with a re-send burst). Keep
  // only the latest payload and render once per animation frame.
  let pendingStreamHtml = null;
  let streamFrameQueued = false;
  const flushStreamHtml = () => {
    streamFrameQueued = false;
    if (pendingStreamHtml === null) return;
    const html = pendingStreamHtml;
    pendingStreamHtml = null;
    renderStreamHtml(html);
  };
  const queueStreamHtml = (html) => {
    if (pendingStreamHtml === html) return; // identical to last coalesced payload
    pendingStreamHtml = html;
    if (streamFrameQueued) return;
    streamFrameQueued = true;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flushStreamHtml);
    } else {
      setTimeout(flushStreamHtml, 0);
    }
  };
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.channel !== 'justsearch-live-artifacts') return;
    if (event.data.event === 'ping') {
      try { parent.postMessage({ channel: 'justsearch-live-artifacts', event: 'pong', frameId: FRAME_ID }, '*'); } catch {}
      return;
    }
    if (event.data.event !== 'stream-render') return;
    queueStreamHtml(event.data.html);
  });
  const parsePayload = (raw) => {
    const value = raw.trim();
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') {
        const instruction = parsed.trim();
        return instruction ? { instruction } : null;
      }
      return parsed;
    } catch {
      return /^[{[]/.test(value) ? null : { instruction: value };
    }
  };
  const resolveScope = (trigger) => {
    const selector = trigger.getAttribute('data-amc-followup-scope');
    if (selector && selector.trim()) {
      try {
        return document.querySelector(selector) || trigger.closest(selector) || document;
      } catch {
        return document;
      }
    }
    return trigger.closest('[data-amc-followup-scope]') || document;
  };
  const readStateValue = (element) => {
    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();
      if (type === 'checkbox') return element.checked;
      if (type === 'radio') return element.checked ? element.value || true : undefined;
      if (type === 'number' || type === 'range') {
        return element.value === '' || Number.isNaN(element.valueAsNumber) ? element.value : element.valueAsNumber;
      }
      return element.value;
    }
    if (element instanceof HTMLSelectElement) {
      return element.multiple ? Array.from(element.selectedOptions).map(option => option.value) : element.value;
    }
    if (element instanceof HTMLTextAreaElement) return element.value;
    const stateValue = element.getAttribute('data-amc-state-value');
    if (stateValue !== null) {
      const toggleLike = element.hasAttribute('aria-pressed') || element.hasAttribute('aria-selected') || element.hasAttribute('aria-checked');
      if (!toggleLike) return stateValue;
      return element.getAttribute('aria-pressed') === 'true' || element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-checked') === 'true'
        ? stateValue
        : undefined;
    }
    const text = element.textContent ? element.textContent.trim() : '';
    return text || undefined;
  };
  const appendState = (state, key, value) => {
    if (value === undefined) return;
    if (Object.prototype.hasOwnProperty.call(state, key)) {
      state[key] = Array.isArray(state[key]) ? [...state[key], value] : [state[key], value];
      return;
    }
    state[key] = value;
  };
  const collectState = (trigger) => {
    const scope = resolveScope(trigger);
    const state = {};
    const elements = [];
    if (scope instanceof Element && scope.matches('[data-amc-state-key]')) elements.push(scope);
    elements.push(...Array.from(scope.querySelectorAll('[data-amc-state-key]')));
    elements.forEach((element) => {
      const key = element.getAttribute('data-amc-state-key');
      if (!key || element.disabled) return;
      appendState(state, key, readStateValue(element));
    });
    return state;
  };
  const mergeState = (payload, state) => {
    if (!state || Object.keys(state).length === 0) return payload;
    const existing = payload && typeof payload.state === 'object' && !Array.isArray(payload.state)
      ? payload.state
      : payload && payload.state !== undefined
        ? { value: payload.state }
        : {};
    return { ...payload, state: { ...existing, ...state } };
  };
  const openSourceUrl = (url) => {
    // Note: this line is inside a JS template literal, so '\/' must be written
    // as '\\/' — a single '\/' is unescaped to '/' and would break the regex
    // (the '/' then starts a comment, taking the whole bridge script down).
    if (!/^https?:\\/\\//i.test(url)) return false;
    try {
      const opened = window.open(url, '_blank');
      if (opened) {
        try { opened.opener = null; } catch {}
        return true;
      }
    } catch {}
    try {
      parent.postMessage({ channel: 'justsearch-live-artifacts', event: 'open-source', url }, '*');
    } catch {}
    return true;
  };
  document.addEventListener('click', (event) => {
    const sourceLink = event.target.closest?.('[data-live-artifact-source-url]');
    if (sourceLink) {
      const url = sourceLink.getAttribute('data-live-artifact-source-url') || '';
      const href = sourceLink.getAttribute('href') || '';
      if (sourceLink.tagName === 'A' && /^https?:\\/\\//i.test(href)) {
        event.preventDefault();
        openSourceUrl(href);
        return;
      }
      if (url) {
        event.preventDefault();
        openSourceUrl(url);
      }
      return;
    }
    const trigger = event.target.closest?.('[data-amc-followup]');
    if (!trigger) return;
    const payload = parsePayload(trigger.getAttribute('data-amc-followup') || '');
    if (!payload) return;
    event.preventDefault();
    parent.postMessage({ channel: 'justsearch-live-artifacts', event: 'followup', payload: mergeState(payload, collectState(trigger)) }, '*');
  });
  // Generic external links: a plain markdown answer coerced into the Live
  // Artifacts frame links to docs as bare <a href="https://…">. Clicking one
  // navigates the sandboxed frame away (the page renders inside the artifact).
  // Open absolute http(s) links in a new tab instead — same path the citation /
  // source-link handlers use. Same-page '#', relative, and non-http links keep
  // their native behavior so multi-page artifacts and mailto:/tel: still work.
  document.addEventListener('click', (event) => {
    try {
      const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      if (anchor.closest('a.live-artifact-citation-link, a.citation-link, [data-live-artifact-source-url], [data-amc-followup]')) return;
      const href = anchor.getAttribute('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      if (!/^https?:\\/\\//i.test(href)) return;
      event.preventDefault();
      openSourceUrl(href);
    } catch {}
  });
  Promise.resolve().then(scheduleResize);
})();
</script>`;

    if (/<\/body>/i.test(code)) {
        return code.replace(/<\/body>/i, `${bridge}</body>`);
    }
    if (/<\/html>/i.test(code)) {
        return code.replace(/<\/html>/i, `${bridge}</html>`);
    }
    return `<!doctype html><html><body>${code}${bridge}</body></html>`;
}

function injectPreviewSecurityPolicy(srcdoc) {
    if (srcdoc.includes(PREVIEW_CONTENT_SECURITY_POLICY)) {
        return srcdoc;
    }
    if (/<head\b[^>]*>/i.test(srcdoc)) {
        return srcdoc.replace(/<head\b[^>]*>/i, headTag => `${headTag}${PREVIEW_CONTENT_SECURITY_POLICY_META}`);
    }
    if (/<html\b[^>]*>/i.test(srcdoc)) {
        return srcdoc.replace(/<html\b[^>]*>/i, htmlTag => `${htmlTag}<head>${PREVIEW_CONTENT_SECURITY_POLICY_META}</head>`);
    }
    return `<!doctype html><html><head>${PREVIEW_CONTENT_SECURITY_POLICY_META}</head><body>${srcdoc}</body></html>`;
}

function getArtifactTitle(block, language, index) {
    const named = parseInfoName(block.info);
    if (named) return named;

    if (language === 'html') {
        const title = block.code.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
        if (title) return stripTags(title);
        const heading = block.code.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.trim();
        if (heading) return stripTags(heading);
        return `Live Web Artifact ${index + 1}`;
    }

    if (language === 'svg') {
        const svgTitle = block.code.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
        return svgTitle ? stripTags(svgTitle) : `SVG Artifact ${index + 1}`;
    }

    return `Artifact ${index + 1}`;
}

function parseInfoName(info) {
    const attrs = parseInfoAttributes(info);
    const named = attrs.title || attrs.name || '';
    if (named) return named.trim();
    const filename = attrs.filename || attrs.file || '';
    if (filename) return filename.replace(/\.[a-z0-9]+$/i, '').trim();
    return '';
}

function parseInfoFileName(info) {
    const attrs = parseInfoAttributes(info);
    const raw = (attrs.filename || attrs.file || '').trim();
    if (!raw) return '';
    const safeName = raw
        .replace(/[\\/]+/g, '-')
        .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    return safeName || '';
}

function inferLanguageFromInfo(info) {
    const attrs = parseInfoAttributes(info);
    const values = [
        attrs.type,
        attrs.mime,
        attrs.mimetype,
        attrs.contenttype,
        attrs.content_type,
        attrs.language,
        attrs.lang,
        attrs.format,
        attrs.filename,
        attrs.file,
    ].filter(Boolean);

    for (const value of values) {
        const lowered = String(value).toLowerCase();
        if (lowered.includes('text/html') || lowered.includes('application/xhtml+xml')) return 'html';
        if (lowered.includes('image/svg+xml')) return 'svg';
        const normalized = normalizeLanguage(value);
        if (ARTIFACT_LANGUAGES.has(normalized)) return normalized;
        if (/\.html?$/i.test(value)) return 'html';
        if (/\.svg$/i.test(value)) return 'svg';
    }

    return '';
}

function parseInfoAttributes(info) {
    const attrs = {};
    const raw = String(info || '');
    const attrRegex = /\b([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
    let match;

    while ((match = attrRegex.exec(raw)) !== null) {
        const key = match[1].toLowerCase().replace(/-/g, '_');
        attrs[key] = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    }

    return attrs;
}

function stripTags(value) {
    const text = String(value || '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]*>/g, '');
    return decodeHtmlEntities(text).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
    return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
        const normalized = entity.toLowerCase();
        if (normalized.startsWith('#x')) {
            const codePoint = Number.parseInt(normalized.slice(2), 16);
            return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
                ? String.fromCodePoint(codePoint)
                : match;
        }
        if (normalized.startsWith('#')) {
            const codePoint = Number.parseInt(normalized.slice(1), 10);
            return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
                ? String.fromCodePoint(codePoint)
                : match;
        }
        return {
            amp: '&',
            lt: '<',
            gt: '>',
            quot: '"',
            apos: "'",
            nbsp: ' ',
        }[normalized] ?? match;
    });
}

function getArtifactFileName(title, language) {
    const ext = language === 'svg' ? 'svg' : language === 'html' ? 'html' : 'txt';
    const base = String(title || 'artifact')
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'artifact';
    return `${base}.${ext}`;
}

function syncRegistryForMessage(messageId, artifacts) {
    Array.from(registry.values()).forEach((artifact) => {
        if (artifact.messageId === messageId) {
            registry.delete(artifact.id);
        }
    });
    artifacts.forEach(artifact => registry.set(artifact.id, artifact));
}

function clearArtifactControls(container) {
    container.querySelectorAll('.live-artifacts-strip').forEach(el => el.remove());
    container.querySelectorAll('.live-artifact-source-strip').forEach(el => el.remove());
    container.querySelectorAll('.live-artifact-open-btn').forEach(el => el.remove());
    container.querySelectorAll('.live-artifact-support-block').forEach((el) => {
        el.classList.remove('live-artifact-support-block');
        el.hidden = false;
        el.removeAttribute('aria-hidden');
    });
}

function renderArtifactStrip(container, artifacts, isStreaming) {
    const strip = document.createElement('div');
    strip.className = 'live-artifacts-strip';
    strip.setAttribute('role', 'list');
    strip.setAttribute('aria-label', 'Live Artifacts');

    const header = document.createElement('div');
    header.className = 'live-artifacts-strip-header';

    const title = document.createElement('div');
    title.className = 'live-artifacts-strip-title';
    const icon = document.createElement('span');
    icon.className = 'material-symbols-rounded';
    icon.textContent = 'auto_awesome_motion';
    title.appendChild(icon);
    title.appendChild(document.createTextNode('Live Artifacts'));

    const meta = document.createElement('span');
    meta.className = 'live-artifacts-strip-meta';
    meta.textContent = isStreaming ? t('liveArtifacts.liveUpdating') : t('liveArtifacts.count', { count: artifacts.length });
    header.appendChild(title);
    header.appendChild(meta);
    strip.appendChild(header);

    const list = document.createElement('div');
    list.className = 'live-artifacts-list';
    artifacts.forEach((artifact) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'live-artifact-card';
        item.dataset.artifactId = artifact.id;
        item.setAttribute('role', 'listitem');
        item.innerHTML = `
            <span class="material-symbols-rounded">preview</span>
            <span class="live-artifact-card-copy">
                <span class="live-artifact-card-title"></span>
                <span class="live-artifact-card-meta"></span>
            </span>
        `;
        item.querySelector('.live-artifact-card-title').textContent = artifact.title;
        item.querySelector('.live-artifact-card-meta').textContent = artifact.language.toUpperCase();
        list.appendChild(item);
    });
    strip.appendChild(list);

    container.prepend(strip);
}

function hashArtifactContent(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return `${text.length}:${(hash >>> 0).toString(36)}`;
}

// Memoize the parent-side height probe by (content hash + width + forceOpen).
// The probe does a full DOM clone + forced synchronous layout, which is the
// single most expensive per-tick cost while streaming; identical content must
// not re-measure. LRU-capped so a long conversation does not grow unbounded.
const HEIGHT_PROBE_MEMO_LIMIT = 40;
const heightProbeMemo = new Map(); // key -> measured height

function memoKeyForHeightProbe(html, widthPx, forceOpenDetails) {
    return `${hashArtifactContent(html)}|${Math.floor(Number(widthPx) || 0)}|${forceOpenDetails ? '1' : '0'}`;
}

function rememberHeightProbe(key, height) {
    if (heightProbeMemo.has(key)) {
        // Refresh recency.
        heightProbeMemo.delete(key);
    }
    heightProbeMemo.set(key, height);
    if (heightProbeMemo.size > HEIGHT_PROBE_MEMO_LIMIT) {
        const oldest = heightProbeMemo.keys().next().value;
        if (oldest !== undefined) heightProbeMemo.delete(oldest);
    }
}

function getArtifactHeightCacheKey(artifact) {
    const html = artifact?.isStreaming ? (artifact.streamHtml || artifact.code || '') : (artifact?.code || '');
    const contentHash = hashArtifactContent(html);
    if (artifact?.isStreaming) {
        return `stream:${artifact.id || 'inline'}`;
    }
    return artifact?.id ? `${artifact.id}:${contentHash}` : `html:${contentHash}`;
}

function readCachedFrameHeight(cacheKey, fallbackKey = '') {
    return (
        frameHeightCache.get(cacheKey)
        ?? (fallbackKey ? frameHeightCache.get(fallbackKey) : undefined)
        ?? INLINE_ARTIFACT_DEFAULT_HEIGHT
    );
}

function cacheFrameHeight(cacheKey, height) {
    if (!cacheKey) return;
    if (frameHeightCache.has(cacheKey)) {
        frameHeightCache.delete(cacheKey);
    }
    frameHeightCache.set(cacheKey, height);
    if (frameHeightCache.size > FRAME_HEIGHT_CACHE_MAX) {
        const oldestKey = frameHeightCache.keys().next().value;
        if (oldestKey) frameHeightCache.delete(oldestKey);
    }
}

/**
 * Parent-side height probe (AMC-WebUI createStaticPreviewSnapshotContainer pattern).
 * Does not depend on sandboxed iframe postMessage, so short-box failures recover reliably.
 * @param {string} html
 * @param {number} widthPx
 * @param {{ forceOpenDetails?: boolean }} [options]
 */
function measureArtifactContentHeight(html, widthPx, options = {}) {
    if (typeof document === 'undefined') return INLINE_ARTIFACT_DEFAULT_HEIGHT;
    const forceOpenDetails = Boolean(options.forceOpenDetails);
    const width = Math.max(280, Math.floor(Number(widthPx) || 680));
    // Same content + same width → same measured height. Skip the DOM clone +
    // forced synchronous layout when nothing changed (the common stream-tick case).
    const memoKey = memoKeyForHeightProbe(html, width, forceOpenDetails);
    if (heightProbeMemo.has(memoKey)) {
        return heightProbeMemo.get(memoKey);
    }
    const probe = document.createElement('div');
    probe.setAttribute('data-amc-height-probe', 'true');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = [
        'position:absolute',
        'left:-100000px',
        'top:0',
        `width:${width}px`,
        'visibility:hidden',
        'pointer-events:none',
        'box-sizing:border-box',
        'overflow:visible',
        'background:transparent',
        'height:auto',
        'max-height:none',
    ].join(';');

    try {
        const raw = String(html || '').trim();
        if (!raw) return INLINE_ARTIFACT_DEFAULT_HEIGHT;

        if (typeof DOMParser !== 'undefined') {
            const parsed = new DOMParser().parseFromString(raw, 'text/html');
            parsed.querySelectorAll('script, iframe, object, embed').forEach(node => node.remove());
            parsed.querySelectorAll('*').forEach((node) => {
                Array.from(node.attributes).forEach((attribute) => {
                    if (/^on/i.test(attribute.name) || attribute.name === 'srcdoc') {
                        node.removeAttribute(attribute.name);
                    }
                });
                // Unclip model-generated full-viewport shells for accurate measurement.
                const style = node.getAttribute('style') || '';
                if (/max-height|height\s*:\s*\d+vh|height\s*:\s*100%|overflow\s*:\s*(auto|scroll|hidden)/i.test(style)) {
                    node.style.setProperty('max-height', 'none', 'important');
                    node.style.setProperty('height', 'auto', 'important');
                    node.style.setProperty('overflow', 'visible', 'important');
                }
            });
            if (forceOpenDetails) {
                parsed.querySelectorAll('details').forEach((details) => {
                    details.setAttribute('open', '');
                    if (details instanceof HTMLElement) {
                        details.style.setProperty('height', 'auto', 'important');
                        details.style.setProperty('max-height', 'none', 'important');
                        details.style.setProperty('overflow', 'visible', 'important');
                    }
                });
            }
            parsed.head.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
                probe.appendChild(document.importNode(node, true));
            });
            Array.from(parsed.body.childNodes).forEach((node) => {
                probe.appendChild(document.importNode(node, true));
            });
        } else {
            probe.innerHTML = raw;
            if (forceOpenDetails) {
                probe.querySelectorAll('details').forEach((details) => details.setAttribute('open', ''));
            }
        }

        // Match the iframe environment: inject the bridge base styles so the
        // probe measures line-height 1.65 / theme tokens instead of the parent
        // page's Inter font. Without this the probe systematically under-reports
        // vs the iframe, seeding a viewport too short to hold the content.
        const baseStyle = document.createElement('style');
        baseStyle.textContent = String(PREVIEW_BASE_STYLES)
            .replace(/<\/?style[^>]*>/g, '');
        probe.insertBefore(baseStyle, probe.firstChild);

        document.body.appendChild(probe);
        let height = Math.ceil(Math.max(probe.scrollHeight || 0, probe.offsetHeight || 0));
        // jsdom / pre-layout environments often report 0; estimate from structure as a floor.
        if (height <= INLINE_ARTIFACT_MIN_HEIGHT) {
            const textLength = (probe.textContent || '').replace(/\s+/g, ' ').trim().length;
            const blockCount = probe.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,tr,pre,blockquote,section,article,div').length;
            const estimated = Math.ceil(textLength / 42) * 22 + blockCount * 28 + 64;
            height = Math.max(height, estimated);
        }
        probe.remove();
        const measured = Math.min(
            INLINE_ARTIFACT_MAX_HEIGHT,
            Math.max(INLINE_ARTIFACT_MIN_HEIGHT, height || INLINE_ARTIFACT_DEFAULT_HEIGHT),
        );
        rememberHeightProbe(memoKey, measured);
        return measured;
    } catch {
        try { probe.remove(); } catch { /* ignore */ }
        return INLINE_ARTIFACT_DEFAULT_HEIGHT;
    }
}

function resolveInlineFrameWidth(viewport, container) {
    const width = viewport?.clientWidth
        || viewport?.getBoundingClientRect?.().width
        || container?.clientWidth
        || container?.getBoundingClientRect?.().width
        || 680;
    return Math.max(280, Math.floor(width));
}

/**
 * Rough text-based floor used only when layout probes fail (e.g. jsdom).
 * Must stay conservative — an inflated estimate was causing huge blank space
 * under real content when used as a permanent height floor.
 */
function estimateArtifactHeightFromMarkup(html) {
    const text = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const textLength = text.length;
    const blockHints = (String(html || '').match(/<(p|h[1-6]|li|tr|div|section|article|details|summary|br)\b/gi) || []).length;
    // Soft floor only — prefer parent probe / iframe bridge for real height.
    return Math.min(
        2400,
        Math.ceil(textLength / 48) * 20 + blockHints * 18 + 96,
    );
}

/**
 * Shared height probe for inline artifacts: measure collapsed + (optional)
 * details-open layouts and fall back to a markup estimate when both collapse
 * to the min box. Preview HTML forces details open (forceOpenAllDetailsInHtml);
 * the parent probe seeds the height and the iframe bridge later corrects it.
 * Never max with inflated text estimates — that left a large empty gap under
 * the real content. The text estimate is only used when layout probes collapse.
 */
function probeInlineArtifactHeight(html, viewport, container) {
    const width = resolveInlineFrameWidth(viewport, container);
    const hasDetails = /<details(?:\s|\/>|>)/i.test(html);
    const collapsed = measureArtifactContentHeight(html, width);
    const expanded = hasDetails
        ? measureArtifactContentHeight(html, width, { forceOpenDetails: true })
        : collapsed;
    const estimated = (hasDetails && expanded <= INLINE_ARTIFACT_MIN_HEIGHT + 8)
        ? estimateArtifactHeightFromMarkup(html)
        : 0;
    return {
        width,
        hasDetails,
        collapsed,
        expanded,
        estimated,
        fullHeight: Math.max(collapsed, expanded, estimated),
    };
}

function syncInlineArtifactFrameHeight(viewport, frame, artifact, container) {
    const cacheKey = getArtifactHeightCacheKey(artifact);
    // Measure the SAME HTML the iframe renders. Streaming content rides the
    // light sanitize-only path (postInlineArtifactStream); final-state content
    // runs the full display chain (buildSrcdoc). Matching the probe HTML to the
    // actual render avoids systematic under/over-report.
    const rawHtml = artifact.isStreaming ? (artifact.streamHtml || artifact.code || '') : (artifact.code || '');
    const sources = Array.isArray(artifact.sources) ? artifact.sources : [];
    const contentHtml = artifact.isStreaming
        ? processArtifactHtmlForDisplay(rawHtml, { streaming: true })
        : processArtifactHtmlForDisplay(rawHtml, { streaming: false, sources });
    const { hasDetails, collapsed, expanded, fullHeight } = probeInlineArtifactHeight(contentHtml, viewport, container);
    if (frame) {
        frame.dataset.liveArtifactCollapsedHeight = String(collapsed);
        // Store pure expanded probe (not inflated) as anti-clip floor for under-reports.
        frame.dataset.liveArtifactExpandedHeight = String(Math.max(collapsed, expanded));
        frame.dataset.liveArtifactHasDetails = hasDetails ? 'true' : 'false';
    }
    const cached = readCachedFrameHeight(cacheKey);
    // Prefer fresh content measure over a tall stale cache entry (avoids blank tails).
    const nextHeight = artifact.isStreaming
        ? Math.max(fullHeight, cached, INLINE_ARTIFACT_MIN_HEIGHT)
        : Math.max(fullHeight, INLINE_ARTIFACT_MIN_HEIGHT);
    cacheFrameHeight(cacheKey, nextHeight);
    if (artifact.id) {
        cacheFrameHeight(`stream:${artifact.id}`, nextHeight);
    }
    applyInlineArtifactFrameHeight(viewport, frame, nextHeight, {
        // Never shrink on the parent-side probe: its height is measured in the
        // parent environment (Inter font) while the iframe renders with the
        // bridge base styles (line-height 1.65, UA font), so the probe
        // systematically under-reports. Shrinking here let a too-small initial
        // value clip content at <br>/<details> boundaries. The iframe bridge
        // may still grow the frame afterward via handleArtifactFrameMessage.
        allowShrink: false,
        enforceExpandedFloor: false,
    });
    return nextHeight;
}

/**
 * Create a fresh Live Artifact iframe node with the AMC-WebUI sandbox and the
 * shared load handler. A brand-new node gets a brand-new browsing context, so
 * this is also the recovery path for Chrome discarding srcdoc documents in
 * background tabs (see pingAndRebuildDeadArtifactFrames).
 */
function createLiveArtifactFrameNode(viewport, container) {
    const frame = document.createElement('iframe');
    frame.className = 'live-artifact-inline-iframe';
    frame.title = 'HTML Preview';
    // Match AMC-WebUI ArtifactFrame sandbox exactly (no allow-same-origin).
    // allow-popups enables target=_blank external links inside Live Artifacts.
    frame.setAttribute(
        'sandbox',
        'allow-scripts allow-forms allow-popups allow-modals allow-downloads',
    );
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('allow', 'clipboard-write');
    // Hint the browser's built-in form/scroll styling for the active scheme.
    frame.style.colorScheme = resolveLiveArtifactThemeId();
    frame.dataset.liveArtifactMountedAt = String(Date.now());
    attachLiveArtifactFrameLoadHandler(frame, viewport, container);
    return frame;
}

/**
 * Shared iframe load handler: after every srcdoc navigation re-push pending
 * stream HTML and re-measure. Sandboxed frames often drop postMessages sent
 * before the bridge listens, so the load handler is the reliable re-push point.
 */
function attachLiveArtifactFrameLoadHandler(frame, viewport, container) {
    frame.addEventListener('load', () => {
        frame.dataset.liveArtifactLoaded = '1';
        // After every srcdoc navigation, re-push pending stream HTML and remeasure.
        // Sandboxed frames often drop postMessages sent before the bridge listens.
        const frameId = frame.dataset.liveArtifactFrameId || '';
        const liveArtifact = frameId ? registry.get(frameId) : null;
        if (liveArtifact) {
            syncPendingStreamToFrame(frame, liveArtifact);
        } else if (frame.dataset.liveArtifactStreaming === 'true' && frame.dataset.liveArtifactProbeHtml) {
            postInlineArtifactStream(frame, frame.dataset.liveArtifactProbeHtml);
        }
        const html = frame.dataset.liveArtifactProbeHtml || '';
        if (!html) return;
        const { hasDetails, collapsed: height, expanded, fullHeight } = probeInlineArtifactHeight(html, viewport, container);
        frame.dataset.liveArtifactCollapsedHeight = String(height);
        frame.dataset.liveArtifactExpandedHeight = String(Math.max(height, expanded));
        frame.dataset.liveArtifactHasDetails = hasDetails ? 'true' : 'false';
        // Seed height from probe; bridge may grow further but never shrink
        // the initial seed (parent probe under-reports iframe metrics).
        applyInlineArtifactFrameHeight(viewport, frame, fullHeight, {
            allowShrink: false,
            enforceExpandedFloor: false,
        });
        cacheFrameHeight(frame.dataset.liveArtifactHeightKey || '', fullHeight);
    });
}

function renderInlineArtifactFrame(container, artifact) {
    let frameShell = container.querySelector(':scope > .live-artifact-inline-frame');
    let viewport = frameShell?.querySelector('.live-artifact-inline-viewport');
    let frame = frameShell?.querySelector('.live-artifact-inline-iframe');

    // Phase 2.1: a mounted shell is never remounted on stream→final. The final
    // content is pushed over postMessage into the SAME iframe (whose head — CSP,
    // theme, font, bridge — is identical to the final srcdoc), so there is no
    // blank-document window while the browser navigates a fresh srcdoc.

    // Streaming with a mounted shell: skip buildSrcdoc entirely (content rides postMessage).
    const streamShellReady = Boolean(
        artifact.isStreaming
        && frame
        && frame.dataset.liveArtifactStreamShell === '1'
        && frame.srcdoc,
    );
    if (streamShellReady) {
        artifact.srcdoc = frame.srcdoc;
    } else {
        // Single bake path (skips when signature unchanged — keeps stream shell stable).
        ensureArtifactSrcdocTheme(artifact);
    }

    if (!frameShell || !viewport || !frame) {
        container.innerHTML = '';
        frameShell = document.createElement('div');
        frameShell.className = 'live-artifact-inline-frame';
        frameShell.dataset.liveArtifactFrame = 'true';

        viewport = document.createElement('div');
        viewport.className = 'live-artifact-inline-viewport';
        viewport.dataset.liveArtifactViewport = 'true';

        frame = createLiveArtifactFrameNode(viewport, container);

        viewport.appendChild(frame);
        frameShell.appendChild(viewport);
        container.appendChild(frameShell);
        frame.dataset.liveArtifactFreshMount = '1';
        // Phase 2.2: register the viewport container with the unload observer so
        // an artifact scrolled far off-screen is unmounted (no iframe for Chrome
        // to discard), then remounted on return.
        observeArtifactViewportContainer(container);
        // Restore the pre-unload height synchronously so a remount does not jump.
        const restoreHeight = container.dataset.liveArtifactRestoreHeight;
        if (restoreHeight && !Number.isNaN(parseInt(restoreHeight, 10))) {
            viewport.style.height = `${restoreHeight}px`;
        }
    }

    const heightKey = getArtifactHeightCacheKey(artifact);
    const contentHtml = artifact.isStreaming ? (artifact.streamHtml || artifact.code || '') : (artifact.code || '');
    frame.dataset.liveArtifactFrameId = artifact.id || '';
    frame.dataset.liveArtifactStreaming = artifact.isStreaming ? 'true' : 'false';
    frame.dataset.liveArtifactHeightKey = heightKey;
    frame.dataset.liveArtifactProbeHtml = contentHtml;

    // Parent-side height probe is the most expensive per-tick step (full DOM clone
    // + forced synchronous layout). While streaming, only probe on the initial
    // mount — the in-iframe bridge reports authoritative heights via resize and
    // grows the viewport, so mid-stream re-probing buys nothing. Final-state bake
    // always probes (below), and the memo keyed by content hash dedups repeats.
    if (!artifact.isStreaming || frame.dataset.liveArtifactFreshMount === '1') {
        syncInlineArtifactFrameHeight(viewport, frame, artifact, container);
    }

    // srcdoc is the single source of truth for FUTURE rebuilds (registry).
    // The live frame gets its content over postMessage; we only assign srcdoc on
    // a brand-new mount (fresh node navigates cleanly in the same task). Once a
    // shell is mounted, never touch frame.srcdoc again — re-assigning navigates
    // the iframe and produces a blank window.
    const shellAlreadyMounted = frame?.dataset?.liveArtifactStreamShell === '1' && frame.srcdoc;
    const isFreshMount = frame?.dataset?.liveArtifactFreshMount === '1';
    if (shellAlreadyMounted) {
        // Stream shell (or a shell that reached final state) stays in place; the
        // final/fresh content is delivered via postMessage below.
    } else if (frame.srcdoc !== artifact.srcdoc) {
        // Brand-new frame: synchronous srcdoc assignment navigates correctly.
        if (isFreshMount) {
            delete frame.dataset.liveArtifactFreshMount;
        }
        frame.srcdoc = artifact.srcdoc;
    }
    if (artifact.isStreaming) {
        frame.dataset.liveArtifactStreamShell = '1';
    } else {
        delete frame.dataset.liveArtifactStreamShell;
        // Final-state backstop: after baking the real srcdoc, re-measure the
        // parent probe once. syncInlineArtifactFrameHeight is allowShrink:false,
        // so this only ever grows the viewport — covering the case where the
        // initial seed measured short (fonts/layout not yet committed) AND the
        // bridge resize message was lost (e.g. background tab rAF suspension).
        // A single sweep keeps the extra layout cost bounded; the bridge resize
        // remains the authoritative growth source.
        scheduleFinalHeightSweep(viewport, frame, artifact, container, 500);
    }
    // Content path: postMessage into the stable shell (retries + load handler).
    // For final state this pushes the fully-processed (theme-adapted, citation-
    // linked) content into the already-mounted iframe — no remount, no blank.
    syncPendingStreamToFrame(frame, artifact);
}

const finalHeightSweepTimers = new WeakMap(); // frame -> Set<number>

/**
 * Final-state backstop: after baking completes, re-run the parent probe after
 * ``delay`` ms. Only grows the viewport (syncInlineArtifactFrameHeight uses
 * allowShrink:false). Covers "seed measured short + bridge resize lost".
 */
function scheduleFinalHeightSweep(viewport, frame, artifact, container, delay) {
    let timers = finalHeightSweepTimers.get(frame);
    if (!timers) {
        timers = new Set();
        finalHeightSweepTimers.set(frame, timers);
    }
    const timer = setTimeout(() => {
        timers.delete(timer);
        if (timers.size === 0) {
            finalHeightSweepTimers.delete(frame);
        }
        try {
            syncInlineArtifactFrameHeight(viewport, frame, artifact, container);
        } catch (err) {
            console.warn('[Live Artifacts] final height sweep failed', err);
        }
    }, delay);
    timers.add(timer);
}

/**
 * Cancel all pending final-height sweeps for a frame. Called when the frame is
 * unmounted (off-screen unload) or replaced so the timer closure cannot fire
 * against a detached node and trigger a stale layout.
 */
function clearFinalHeightSweeps(frame) {
    if (!frame) return;
    const timers = finalHeightSweepTimers.get(frame);
    if (!timers) return;
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
    finalHeightSweepTimers.delete(frame);
}

function syncPendingStreamToFrame(frame, artifact) {
    if (!frame || !artifact) return;
    const html = artifact.isStreaming
        ? (artifact.streamHtml || artifact.code || '')
        : (artifact.code || '');
    if (!html || !String(html).trim()) return;
    // Streaming: light path. Final state: full path (theme/citations/details) so
    // the in-place push matches what a rebuild-from-registry would render.
    postInlineArtifactStream(frame, html, { streaming: !artifact.isStreaming });
}

function postInlineArtifactStream(frame, html, options = {}) {
    if (!frame || typeof html !== 'string' || !html.trim()) return;
    // Streaming path stays light: sanitize clip-shells only. Theme adaptation,
    // details force-open, token materialize, and citation linking are deferred to
    // the final bake (processArtifactHtmlForDisplay streaming:false), so each
    // stream tick no longer pays for the heavy regex + DOM walk. Final-state
    // pushes (streaming:false) run the full chain once, in-place.
    const isFinal = options.streaming === false;
    const adaptedHtml = processArtifactHtmlForDisplay(html, { streaming: !isFinal });
    // Phase 3: while the tab is hidden, do NOT postMessage — Chrome throttles
    // hidden tabs and the bridge rAF is frozen, so pushes are wasted. Record the
    // latest content and mark the frame dirty; the visibilitychange handler
    // flushes exactly one final push when the tab comes back.
    const applyLatest = () => {
        frame.dataset.liveArtifactPendingStreamHtml = adaptedHtml;
        frame.dataset.liveArtifactDirty = '1';
    };
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        applyLatest();
        return;
    }
    // Skip identical re-posts (rAF can re-enter with unchanged buffer).
    if (frame.dataset.liveArtifactPendingStreamHtml === adaptedHtml) {
        // Still re-send once so late-loading bridge can catch up.
        try {
            frame.contentWindow?.postMessage({
                channel: 'justsearch-live-artifacts',
                event: STREAM_RENDER_EVENT,
                html: adaptedHtml,
            }, '*');
        } catch {
            // Ignore frame messaging failures while the iframe is mounting.
        }
        return;
    }
    applyLatest();
    const send = () => {
        try {
            frame.contentWindow?.postMessage({
                channel: 'justsearch-live-artifacts',
                event: STREAM_RENDER_EVENT,
                html: adaptedHtml,
            }, '*');
        } catch {
            // Ignore frame messaging failures while the iframe is mounting.
        }
    };
    // Retries cover the common race where srcdoc navigation has not installed the
    // bridge listener yet (setTimeout(0) alone is often too early). A final push
    // needs fewer retries because the shell has long been mounted by then.
    send();
    if (isFinal) {
        setTimeout(send, 50);
        setTimeout(send, 200);
    } else {
        setTimeout(send, 0);
        setTimeout(send, 50);
        setTimeout(send, 150);
        setTimeout(send, 400);
    }
}

/**
 * Phase 3: when the tab becomes visible again, push exactly the latest content
 * to every Live Artifact frame that accumulated changes while hidden. Frames are
 * marked dirty by postInlineArtifactStream (which skips postMessage while
 * document.hidden) — here we re-send once and clear the flag.
 */
function flushDirtyArtifactFrames() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('.live-artifact-inline-iframe').forEach((frame) => {
        if (frame.dataset?.liveArtifactDirty !== '1') return;
        const html = frame.dataset.liveArtifactPendingStreamHtml || frame.dataset.liveArtifactProbeHtml || '';
        if (!html) return;
        frame.dataset.liveArtifactDirty = '0';
        postInlineArtifactStream(frame, html);
    });
}

function normalizeArtifactSources(sources) {
    const sourceList = Array.isArray(sources) ? sources : (() => {
        if (typeof sources !== 'string') return [];
        try {
            const parsed = JSON.parse(sources);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    })();

    return sourceList
        .map((source, index) => {
            if (typeof source === 'string') {
                const url = source.trim();
                return {
                    id: String(index + 1),
                    title: url || `Source ${index + 1}`,
                    url,
                };
            }
            return {
                id: String(source?.id ?? index + 1).trim() || String(index + 1),
                title: String(source?.title || source?.url || `Source ${index + 1}`).replace(/\s+/g, ' ').trim(),
                url: String(source?.url || '').trim(),
            };
        })
        .filter(source => source.title || source.url);
}

function getSourceHost(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

function getCitedSourceIds(code) {
    const ids = new Set();
    const regex = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
    let match;
    while ((match = regex.exec(String(code || ''))) !== null) {
        match[1].split(',').forEach(id => {
            const trimmed = id.trim();
            if (trimmed) ids.add(trimmed);
        });
    }
    return ids;
}

function selectArtifactSources(artifact, sources) {
    if (!artifact || sources.length === 0) return [];
    const citedIds = getCitedSourceIds(artifact.code);
    const selected = citedIds.size > 0
        ? sources.filter(source => citedIds.has(String(source.id)))
        : sources;
    return selected.slice(0, 8);
}

function renderLiveArtifactSources(container, artifact, sources) {
    container.querySelectorAll('.live-artifact-source-strip').forEach(el => el.remove());
    const selected = selectArtifactSources(artifact, sources);
    if (selected.length === 0) return;

    const strip = document.createElement('div');
    strip.className = 'live-artifact-source-strip';
    strip.setAttribute('aria-label', t('liveArtifacts.searchSources'));

    const header = document.createElement('div');
    header.className = 'live-artifact-source-header';
    const icon = document.createElement('span');
    icon.className = 'material-symbols-rounded';
    icon.textContent = 'travel_explore';
    const label = document.createElement('span');
    label.textContent = t('liveArtifacts.searchSources');
    const count = document.createElement('span');
    count.className = 'live-artifact-source-count';
    count.textContent = t('liveArtifacts.selectedCount', { count: selected.length });
    header.append(icon, label, count);
    strip.appendChild(header);

    const list = document.createElement('div');
    list.className = 'live-artifact-source-list';
    selected.forEach((source) => {
        const safeUrl = getSafeUrl(source.url);
        const item = safeUrl ? document.createElement('a') : document.createElement('span');
        item.className = safeUrl ? 'live-artifact-source-chip' : 'live-artifact-source-chip is-disabled';
        if (safeUrl) {
            item.href = safeUrl;
            item.target = '_blank';
            item.rel = 'noopener noreferrer';
        }

        const id = document.createElement('span');
        id.className = 'live-artifact-source-id';
        id.textContent = `[${source.id}]`;
        const title = document.createElement('span');
        title.className = 'live-artifact-source-title';
        title.textContent = source.title || source.url || `Source ${source.id}`;
        item.title = title.textContent;

        item.append(id, title);
        const host = safeUrl ? getSourceHost(safeUrl) : '';
        if (host) {
            const hostEl = document.createElement('span');
            hostEl.className = 'live-artifact-source-host';
            hostEl.textContent = host;
            item.appendChild(hostEl);
        }
        list.appendChild(item);
    });
    strip.appendChild(list);
    container.appendChild(strip);
}

function renderLiveArtifactInteraction(container, spec) {
    container.innerHTML = '';

    if (spec.pending) {
        const pending = document.createElement('div');
        pending.className = 'live-artifact-interaction pending';
        pending.dataset.liveArtifactInteractionPending = 'true';
        pending.textContent = t('liveArtifacts.preparingForm');
        container.appendChild(pending);
        return;
    }

    const form = document.createElement('form');
    form.className = 'live-artifact-interaction';
    form.dataset.liveArtifactInteraction = 'true';

    const header = document.createElement('div');
    header.className = 'live-artifact-interaction-header';
    if (spec.title) {
        const title = document.createElement('h2');
        title.textContent = spec.title;
        header.appendChild(title);
    }
    if (spec.description) {
        const description = document.createElement('p');
        description.textContent = spec.description;
        header.appendChild(description);
    }
    form.appendChild(header);

    const fields = document.createElement('div');
    fields.className = 'live-artifact-interaction-fields';
    const required = new Set(spec.schema.required || []);
    Object.entries(spec.schema.properties).forEach(([key, property]) => {
        fields.appendChild(createInteractionField(key, property, required.has(key)));
    });
    form.appendChild(fields);

    const error = document.createElement('p');
    error.className = 'live-artifact-interaction-error';
    error.hidden = true;
    form.appendChild(error);

    const actions = document.createElement('div');
    actions.className = 'live-artifact-interaction-actions';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'live-artifact-interaction-submit';
    submit.innerHTML = '<span class="material-symbols-rounded">send</span><span></span>';
    submit.querySelector('span:last-child').textContent = spec.submitLabel || t('liveArtifacts.continue');
    actions.appendChild(submit);
    form.appendChild(actions);

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const result = readInteractionFormState(form, spec);
        if (result.error) {
            error.textContent = result.error;
            error.hidden = false;
            return;
        }
        error.hidden = true;
        const prompt = formatInteractionFollowupPrompt({
            instruction: spec.instruction,
            ...(spec.title ? { title: spec.title } : {}),
            source: INTERACTION_SOURCE,
            state: result.state,
        });
        const input = document.getElementById('user-input');
        if (input) {
            input.value = prompt;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
        }
        showToast(t('liveArtifacts.filledNextRequest'), 'success');
    });

    container.appendChild(form);
}

function createInteractionField(key, property, required) {
    const wrapper = document.createElement('label');
    wrapper.className = property.type === 'boolean'
        ? 'live-artifact-interaction-field boolean'
        : 'live-artifact-interaction-field';

    const label = document.createElement('span');
    label.className = 'live-artifact-interaction-label';
    label.textContent = property.title || key;
    if (required) {
        const requiredMark = document.createElement('span');
        requiredMark.className = 'live-artifact-interaction-required';
        requiredMark.textContent = '*';
        label.appendChild(requiredMark);
    }

    const description = property.description ? document.createElement('span') : null;
    if (description) {
        description.className = 'live-artifact-interaction-description';
        description.textContent = property.description;
    }

    const control = createInteractionControl(key, property, required);
    if (property.type === 'boolean') {
        wrapper.appendChild(control);
        const copy = document.createElement('span');
        copy.className = 'live-artifact-interaction-copy';
        copy.appendChild(label);
        if (description) copy.appendChild(description);
        wrapper.appendChild(copy);
    } else {
        wrapper.appendChild(label);
        if (description) wrapper.appendChild(description);
        wrapper.appendChild(control);
    }
    return wrapper;
}

function createInteractionControl(key, property, required) {
    const defaultValue = property.default ?? property.enum?.[0] ?? (property.type === 'boolean' ? false : '');

    if (property.type === 'boolean') {
        const input = document.createElement('input');
        input.name = key;
        input.type = 'checkbox';
        input.checked = Boolean(defaultValue);
        return input;
    }

    if (property.enum) {
        const select = document.createElement('select');
        select.name = key;
        select.required = required;
        property.enum.forEach((option, index) => {
            const item = document.createElement('option');
            item.value = String(option);
            item.textContent = property.enumNames?.[index] || String(option);
            select.appendChild(item);
        });
        select.value = String(defaultValue);
        return select;
    }

    if (property.format === 'textarea') {
        const textarea = document.createElement('textarea');
        textarea.name = key;
        textarea.required = required;
        textarea.rows = 4;
        textarea.value = String(defaultValue);
        return textarea;
    }

    const input = document.createElement('input');
    input.name = key;
    input.type = property.type === 'string' ? 'text' : 'number';
    input.required = required;
    if (property.type === 'integer') input.step = '1';
    if (property.minimum !== undefined) input.min = String(property.minimum);
    if (property.maximum !== undefined) input.max = String(property.maximum);
    input.value = String(defaultValue);
    return input;
}

function readInteractionFormState(form, spec) {
    const state = {};
    for (const [key, property] of Object.entries(spec.schema.properties)) {
        const required = (spec.schema.required || []).includes(key);
        const control = form.elements[key];
        const value = readInteractionControlValue(control, property);
        if (required && (value === '' || value === undefined)) {
            return { error: t('liveArtifacts.errRequiredFields') };
        }
        if ((property.type === 'number' || property.type === 'integer') && value !== '') {
            if (typeof value !== 'number' || !Number.isFinite(value)) return { error: t('liveArtifacts.errValidNumber') };
            if (property.type === 'integer' && !Number.isInteger(value)) return { error: t('liveArtifacts.errInteger') };
            if (property.minimum !== undefined && value < property.minimum) return { error: t('liveArtifacts.errOutOfRange') };
            if (property.maximum !== undefined && value > property.maximum) return { error: t('liveArtifacts.errOutOfRange') };
        }
        if (property.enum && !property.enum.some(option => String(option) === String(value))) {
            return { error: t('liveArtifacts.errInvalidOption') };
        }
        state[key] = value;
    }
    return { state };
}

function readInteractionControlValue(control, property) {
    if (!control) return '';
    if (property.type === 'boolean') return Boolean(control.checked);
    if (property.type === 'number' || property.type === 'integer') {
        if (control.value === '') return '';
        const value = Number(control.value);
        return Number.isFinite(value) ? value : Number.NaN;
    }
    return control.value || '';
}

function formatInteractionFollowupPrompt(payload) {
    const lines = [t('liveArtifacts.instructionPrompt'), '', t('liveArtifacts.instructionLabel', { instruction: payload.instruction })];
    if (payload.title) lines.push(t('liveArtifacts.titleLabel', { title: payload.title }));
    lines.push('', t('liveArtifacts.stateLabel'), JSON.stringify(payload.state || {}, null, 2), '', `source: ${payload.source}`);
    return lines.join('\n');
}

function applyInlineArtifactFrameHeight(viewport, frame, height, {
    allowShrink = true,
    enforceExpandedFloor = false,
} = {}) {
    // AMC ArtifactFrame: normalizeFrameHeight = max(MIN, ceil(height)).
    // JustSearch adds a small pad so overflow:hidden does not clip subpixel bottoms.
    const HEIGHT_PAD = 8;
    let requested = Math.max(
        INLINE_ARTIFACT_MIN_HEIGHT,
        Math.ceil(Number(height) || 0) + HEIGHT_PAD,
    );
    // Optional anti-clip floor (only when bridge clearly under-reports collapsed height).
    // Always enforcing expandedHeight left a large blank gap under real content.
    if (enforceExpandedFloor && frame?.dataset?.liveArtifactHasDetails === 'true') {
        const expandedFloor = parseInt(frame.dataset.liveArtifactExpandedHeight, 10) || 0;
        if (expandedFloor > 0) {
            requested = Math.max(requested, expandedFloor + HEIGHT_PAD);
        }
    }
    const capped = Math.min(INLINE_ARTIFACT_MAX_HEIGHT, requested);
    const current = Math.max(
        parseInt(frame?.style?.height, 10) || 0,
        parseInt(viewport?.style?.height, 10) || 0,
        0,
    );
    // Growth always applies; shrink only when allowShrink is true.
    const nextHeight = allowShrink
        ? capped
        : Math.max(current || INLINE_ARTIFACT_DEFAULT_HEIGHT, capped);
    const next = `${nextHeight}px`;
    if (viewport) {
        viewport.style.height = next;
        viewport.style.minHeight = `${INLINE_ARTIFACT_MIN_HEIGHT}px`;
        // AMC ArtifactFrame viewport: overflow-hidden + explicit height.
        viewport.style.overflow = 'hidden';
    }
    if (frame) {
        // AMC uses h-full of the viewport; set explicit px so sandbox iframe always fills.
        frame.style.height = next;
        frame.style.minHeight = `${INLINE_ARTIFACT_MIN_HEIGHT}px`;
        frame.setAttribute('scrolling', 'no');
    }
    if (frame?.dataset?.liveArtifactHeightKey) {
        cacheFrameHeight(frame.dataset.liveArtifactHeightKey, nextHeight);
    }
    return nextHeight;
}



function decorateCodeBlocks(codeBlocks, artifacts) {
    artifacts.forEach((artifact) => {
        const codeBlock = codeBlocks[artifact.blockIndex];
        const header = codeBlock?.querySelector('.code-block-header');
        if (!header) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'code-copy-btn live-artifact-open-btn';
        btn.dataset.artifactId = artifact.id;
        btn.title = t('liveArtifacts.openArtifact');
        btn.innerHTML = `<span class="material-symbols-rounded">preview</span><span>${t('liveArtifacts.preview')}</span>`;
        header.appendChild(btn);
    });
}

function hideSupportingCodeBlocks(codeBlocks, artifacts) {
    const supportBlockIndices = new Set();
    artifacts.forEach((artifact) => {
        if (!artifact.renderable) return;
        (artifact.supportBlockIndices || []).forEach((blockIndex) => {
            if (blockIndex !== artifact.blockIndex) supportBlockIndices.add(blockIndex);
        });
    });

    supportBlockIndices.forEach((blockIndex) => {
        const codeBlock = codeBlocks[blockIndex];
        if (!codeBlock) return;
        codeBlock.classList.add('live-artifact-support-block');
        codeBlock.hidden = true;
        codeBlock.setAttribute('aria-hidden', 'true');
    });
}

function ensurePanel() {
    if (panelState) return panelState;

    const backdrop = document.createElement('div');
    backdrop.className = 'live-artifacts-backdrop';
    backdrop.hidden = true;

    const panel = document.createElement('aside');
    panel.className = 'live-artifacts-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Live Artifact');
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML = `
        <div class="live-artifacts-panel-header">
            <div class="live-artifacts-title-block">
                <div class="live-artifacts-kicker">Live Artifact</div>
                <div class="live-artifacts-title">Artifact</div>
                <div class="live-artifacts-meta"></div>
            </div>
            <button type="button" class="live-artifacts-icon-btn live-artifacts-close-btn" aria-label="${t('liveArtifacts.closeArtifact')}">
                <span class="material-symbols-rounded">close</span>
            </button>
        </div>
        <div class="live-artifacts-toolbar">
            <div class="live-artifacts-tabs" role="tablist" aria-label="${t('liveArtifacts.artifactViews')}">
                <button type="button" id="live-artifacts-tab-preview" class="live-artifacts-tab is-active" data-artifact-view="preview" role="tab" aria-selected="true" aria-controls="live-artifacts-preview-panel">${t('liveArtifacts.preview')}</button>
                <button type="button" id="live-artifacts-tab-code" class="live-artifacts-tab" data-artifact-view="code" role="tab" aria-selected="false" aria-controls="live-artifacts-code-panel">${t('liveArtifacts.code')}</button>
            </div>
            <div class="live-artifacts-actions">
                <button type="button" class="live-artifacts-icon-btn" data-artifact-action="copy" aria-label="${t('liveArtifacts.copyCode')}" title="${t('liveArtifacts.copyCode')}">
                    <span class="material-symbols-rounded">content_copy</span>
                </button>
                <button type="button" class="live-artifacts-icon-btn" data-artifact-action="download" aria-label="${t('liveArtifacts.downloadArtifact')}" title="${t('liveArtifacts.downloadArtifact')}">
                    <span class="material-symbols-rounded">download</span>
                </button>
                <button type="button" class="live-artifacts-icon-btn" data-artifact-action="open" aria-label="${t('liveArtifacts.openNewWindow')}" title="${t('liveArtifacts.openNewWindow')}">
                    <span class="material-symbols-rounded">open_in_new</span>
                </button>
            </div>
        </div>
        <div class="live-artifacts-panel-body">
            <div id="live-artifacts-preview-panel" class="live-artifacts-preview-view is-active" role="tabpanel" aria-labelledby="live-artifacts-tab-preview">
                <iframe class="live-artifacts-frame" title="Live Artifact Preview" sandbox="allow-scripts allow-forms allow-modals allow-popups"></iframe>
                <div class="live-artifacts-empty" hidden>${t('liveArtifacts.noPreview')}</div>
            </div>
            <pre id="live-artifacts-code-panel" class="live-artifacts-code-view" role="tabpanel" aria-labelledby="live-artifacts-tab-code"><code></code></pre>
        </div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);

    panelState = {
        backdrop,
        panel,
        title: panel.querySelector('.live-artifacts-title'),
        meta: panel.querySelector('.live-artifacts-meta'),
        frame: panel.querySelector('.live-artifacts-frame'),
        empty: panel.querySelector('.live-artifacts-empty'),
        code: panel.querySelector('.live-artifacts-code-view code'),
        previewView: panel.querySelector('.live-artifacts-preview-view'),
        codeView: panel.querySelector('.live-artifacts-code-view'),
        tabs: Array.from(panel.querySelectorAll('.live-artifacts-tab')),
    };

    wirePanelEvents();
    return panelState;
}

function wirePanelEvents() {
    document.addEventListener('click', handleArtifactDocumentClick);
    window.addEventListener('message', handleArtifactFrameMessage);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && document.body.classList.contains('live-artifacts-open')) {
            closeLiveArtifactsPanel();
        }
    });
    panelState.backdrop.addEventListener('click', closeLiveArtifactsPanel);
    panelState.panel.querySelector('.live-artifacts-close-btn').addEventListener('click', closeLiveArtifactsPanel);
}

function handleArtifactFrameMessage(event) {
    const data = event.data || {};
    if (data.channel !== 'justsearch-live-artifacts') return;
    const sourceFrame = findArtifactFrameByMessage(event);
    if (!sourceFrame) return;

    if (data.event === 'ready') {
        // Bridge is listening — re-deliver any pending stream HTML that raced load.
        const frame = sourceFrame.frame;
        const frameId = frame.dataset.liveArtifactFrameId || '';
        const artifact = frameId ? registry.get(frameId) : null;
        if (artifact) {
            syncPendingStreamToFrame(frame, artifact);
        } else if (frame.dataset.liveArtifactPendingStreamHtml) {
            postInlineArtifactStream(frame, frame.dataset.liveArtifactPendingStreamHtml);
        } else if (frame.dataset.liveArtifactStreaming === 'true' && frame.dataset.liveArtifactProbeHtml) {
            postInlineArtifactStream(frame, frame.dataset.liveArtifactProbeHtml);
        }
        if (sourceFrame.kind === 'inline') {
            const viewport = frame.closest('.live-artifact-inline-viewport');
            // Direct height sync backstop: final-state height must not depend on
            // a later bridge resize arriving on time. Measure now.
            if (viewport && artifact && !artifact.isStreaming) {
                const container = viewport.closest('.live-artifact-inline-frame')?.parentElement || null;
                try {
                    syncInlineArtifactFrameHeight(viewport, frame, artifact, container);
                } catch (err) {
                    console.warn('[Live Artifacts] ready-height sync failed', err);
                }
            }
        }
        return;
    }

    if (data.event === 'resize' && typeof data.height === 'number' && Number.isFinite(data.height)) {
        if (sourceFrame.kind === 'inline') {
            const frame = sourceFrame.frame;
            const viewport = frame.closest('.live-artifact-inline-viewport');
            const hasDetails = frame.dataset.liveArtifactHasDetails === 'true';
            const collapsed = parseInt(frame.dataset.liveArtifactCollapsedHeight, 10) || 0;
            const expanded = parseInt(frame.dataset.liveArtifactExpandedHeight, 10) || 0;

            // AMC: apply bridge height. The bridge measures the iframe's real
            // document, so it is the authority on growth. Early/probe-era under-
            // reports must NOT shrink the seeded viewport — that clips content
            // (no later grow pulls it back). Only the classic under-report needs
            // the expanded-floor guard; everything else grows unconditionally.
            const openDetailsCount = Number.isFinite(data.openDetailsCount)
                ? data.openDetailsCount
                : null;
            const detailsAllCollapsed = openDetailsCount === 0;
            const underReported = hasDetails
                && collapsed > 0
                && !detailsAllCollapsed
                && data.height <= collapsed + 80;
            let targetHeight = data.height;
            if (underReported && expanded > 0) {
                targetHeight = Math.max(data.height, expanded);
            } else if (hasDetails && data.height > collapsed + 80) {
                // Learn real content height from the iframe (may be lower than parent probe).
                frame.dataset.liveArtifactExpandedHeight = String(Math.ceil(data.height));
            }

            applyInlineArtifactFrameHeight(viewport, frame, targetHeight, {
                // Bridge resize never shrinks: a single early under-report would
                // clip content with no guarantee of a corrective grow afterward.
                // Overshoot is corrected on the next probe pass, not here.
                allowShrink: false,
                enforceExpandedFloor: underReported,
            });
        } else if (sourceFrame.kind === 'panel' && panelState?.frame) {
            // Side panel preview uses the same bridge; grow with content when possible.
            const panelFrame = panelState.frame;
            const next = Math.max(INLINE_ARTIFACT_MIN_HEIGHT, Math.ceil(data.height) + 8);
            panelFrame.style.height = `${Math.min(INLINE_ARTIFACT_MAX_HEIGHT, next)}px`;
        }
        return;
    }

    if (data.event === 'followup') {
        const payload = normalizeFollowupPayload(data.payload);
        if (payload) {
            const input = document.getElementById('user-input');
            if (input) {
                input.value = formatInteractionFollowupPrompt(payload);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.focus();
            }
        }
        return;
    }

    if (data.event === 'open-source') {
        openArtifactSourceUrl(data.url);
        return;
    }

    if (data.event === 'diagnostic') {
        handlePreviewDiagnostic(data.payload);
    }
}

function findArtifactFrameByMessage(event) {
    const data = event?.data || {};
    const frameId = typeof data.frameId === 'string' ? data.frameId.trim() : '';
    if (frameId) {
        const frames = Array.from(document.querySelectorAll('.live-artifact-inline-iframe'));
        const byId = frames.find(frame => frame.dataset.liveArtifactFrameId === frameId);
        if (byId) {
            return { frame: byId, kind: 'inline' };
        }
        // Diagnostic: a resize the parent could not route. If this fires after
        // the fixes, the bridge message-routing is the culprit (not the probe).
        if (data.event === 'resize') {
            console.warn('[Live Artifacts] resize 消息未找到目标 frame', {
                frameId,
                available: frames.map(f => f.dataset.liveArtifactFrameId || '(empty)'),
            });
        }
    }
    return findArtifactFrameByMessageSource(event?.source);
}

function findArtifactFrameByMessageSource(source) {
    if (!source) return null;

    const inlineFrame = Array.from(document.querySelectorAll('.live-artifact-inline-iframe'))
        .find(frame => frame.contentWindow === source);
    if (inlineFrame) {
        return { frame: inlineFrame, kind: 'inline' };
    }

    if (panelState?.frame?.contentWindow === source) {
        return { frame: panelState.frame, kind: 'panel' };
    }

    return null;
}

function openArtifactSourceUrl(url) {
    const safeUrl = getSafeUrl(url);
    if (!safeUrl) {
        showToast(t('liveArtifacts.invalidSourceUrl'), 'warning', 4000);
        return;
    }
    window.open(safeUrl, '_blank', 'noopener,noreferrer');
}

function handlePreviewDiagnostic(payload) {
    const diagnostic = normalizePreviewDiagnostic(payload);
    if (!diagnostic) return;

    if (diagnostic.type === 'resource-error') {
        console.warn('[Live Artifacts] Preview resource failed to load.', diagnostic);
    } else if (diagnostic.type === 'csp-violation') {
        console.warn('[Live Artifacts] Preview content was blocked by CSP.', diagnostic);
    } else {
        console.warn('[Live Artifacts] Preview runtime error.', diagnostic);
    }

    const now = Date.now();
    if (now - lastDiagnosticToastAt > 5000) {
        lastDiagnosticToastAt = now;
        showToast(t('liveArtifacts.previewIssue'), 'warning', 5000);
    }
}

function normalizePreviewDiagnostic(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }
    const type = typeof payload.type === 'string' ? payload.type : '';
    if (!['resource-error', 'runtime-error', 'csp-violation'].includes(type)) {
        return null;
    }
    const diagnostic = { type };
    ['tagName', 'url', 'message', 'source', 'blockedURI', 'violatedDirective', 'effectiveDirective'].forEach((key) => {
        if (typeof payload[key] === 'string' && payload[key].trim()) {
            diagnostic[key] = payload[key].trim();
        }
    });
    ['line', 'column'].forEach((key) => {
        if (typeof payload[key] === 'number' && Number.isFinite(payload[key])) {
            diagnostic[key] = payload[key];
        }
    });
    return diagnostic;
}

function normalizeFollowupPayload(payload) {
    if (typeof payload === 'string') {
        const instruction = payload.trim();
        return instruction ? { instruction } : null;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }
    const instruction = typeof payload.instruction === 'string' ? payload.instruction.trim() : '';
    if (!instruction) return null;
    return {
        instruction,
        ...(typeof payload.title === 'string' && payload.title.trim() ? { title: payload.title.trim() } : {}),
        source: typeof payload.source === 'string' && payload.source.trim() ? payload.source.trim() : 'data-amc-followup',
        ...(payload.state && typeof payload.state === 'object' && !Array.isArray(payload.state) ? { state: payload.state } : {}),
    };
}

function handleArtifactDocumentClick(event) {
    const openTarget = event.target.closest('[data-artifact-id]');
    if (openTarget) {
        const artifact = registry.get(openTarget.dataset.artifactId);
        if (artifact) {
            event.preventDefault();
            openLiveArtifactsPanel(artifact.id);
        }
        return;
    }

    const viewButton = event.target.closest('[data-artifact-view]');
    if (viewButton && panelState?.panel.contains(viewButton)) {
        setArtifactView(viewButton.dataset.artifactView);
        return;
    }

    const actionButton = event.target.closest('[data-artifact-action]');
    if (actionButton && panelState?.panel.contains(actionButton)) {
        handleArtifactAction(actionButton.dataset.artifactAction);
    }
}

function openLiveArtifactsPanel(artifactId) {
    const artifact = registry.get(artifactId);
    if (!artifact) return;

    activeArtifactId = artifact.id;
    activeArtifactKey = artifact.key;
    ensurePanel();
    document.body.classList.add('live-artifacts-open');
    panelState.backdrop.hidden = false;
    panelState.panel.setAttribute('aria-hidden', 'false');
    renderPanel(artifact);
}

function closeLiveArtifactsPanel() {
    if (!panelState) return;
    document.body.classList.remove('live-artifacts-open');
    panelState.backdrop.hidden = true;
    panelState.panel.setAttribute('aria-hidden', 'true');
    activeArtifactId = '';
    activeArtifactKey = '';
}

function renderPanel(artifact) {
    if (!panelState) return;

    ensureArtifactSrcdocTheme(artifact);
    panelState.title.textContent = artifact.title;
    panelState.meta.textContent = `${artifact.language.toUpperCase()} · ${artifact.fileName}`;
    panelState.code.textContent = artifact.code;

    const canPreview = Boolean(artifact.renderable && artifact.srcdoc);
    panelState.frame.hidden = !canPreview;
    panelState.empty.hidden = canPreview;
    if (canPreview) {
        panelState.frame.style.colorScheme = resolveLiveArtifactThemeId();
        panelState.frame.srcdoc = artifact.srcdoc;
    } else {
        panelState.frame.removeAttribute('srcdoc');
    }

    setArtifactView(canPreview ? activeView : 'code', { preservePreference: canPreview });
}

function setArtifactView(view, { preservePreference = true } = {}) {
    const nextView = view === 'code' ? 'code' : 'preview';
    if (preservePreference) activeView = nextView;

    panelState.tabs.forEach((tab) => {
        const isActive = tab.dataset.artifactView === nextView;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    panelState.previewView.classList.toggle('is-active', nextView === 'preview');
    panelState.codeView.classList.toggle('is-active', nextView === 'code');
}

async function handleArtifactAction(action) {
    const artifact = registry.get(activeArtifactId);
    if (!artifact) return;

    if (action === 'copy') {
        try {
            await navigator.clipboard.writeText(artifact.code);
            showToast(t('liveArtifacts.codeCopied'), 'success');
        } catch {
            showToast(t('liveArtifacts.copyFailed'), 'error');
        }
        return;
    }

    if (action === 'download') {
        downloadArtifact(artifact);
        return;
    }

    if (action === 'open') {
        openArtifactInNewWindow(artifact);
    }
}

function downloadArtifact(artifact) {
    const blob = new Blob([artifact.code], { type: artifact.language === 'svg' ? 'image/svg+xml' : 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = artifact.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openArtifactInNewWindow(artifact) {
    const content = artifact.srcdoc || artifact.code;
    const blob = new Blob([content], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const FRAME_PING_TIMEOUT_MS = 1500;
// Fast window used when a frame scrolls into view: healthy frames confirm with
// a synchronous pong in a fraction of this, dead frames are rebuilt quickly so
// the user does not stare at a white artifact for the full 1.5s.
const FRAME_VIEW_RECOVERY_TIMEOUT_MS = 150;
// Phase 2.3: after a background stay wakes the tab, only frames still inside the
// viewport are pinged, and the window is shortened so a discarded document is
// replaced almost immediately (Phase 2.2 already removed the off-screen frames).
const FRAME_WAKE_RECOVERY_TIMEOUT_MS = 300;
let visibilityRecoveryInitialized = false;

// Phase 2.2: off-screen unloading. Chrome can only discard a document that
// EXISTS off-screen; if we remove the iframe while the artifact is well out of
// view, the blank-screen root cause disappears. A 1.5-screen rootMargin keeps
// frames mounted a little beyond the edges (no flash on fast flick-past); we
// unload after a 2s delay once fully out of the expanded region.
const LA_VIEWPORT_UNLOAD_ENABLED = true;
const LA_UNLOAD_DELAY_MS = 2000;
// One observer for all inline artifact viewport containers (not a second
// observer — merged into initLiveArtifactVisibilityRecovery below).
let viewportUnloadObserver = null;
const observedViewportContainers = new Set();
const unloadTimers = new WeakMap(); // container -> setTimeout id

/**
 * Ping a single Live Artifact frame's bridge. Frames that answer `pong` are
 * healthy; frames that do not within FRAME_PING_TIMEOUT_MS have had their
 * srcdoc document discarded and are rebuilt as brand-new nodes. Unlike the
 * full ping (background-tab recovery), this targets one frame — used when a
 * frame scrolls back into the viewport, where Chrome may have dropped its
 * off-screen document even while the page stays in the foreground.
 */

// ---------------------------------------------------------------------------
// Phase 2.2: off-screen unload + on-demand remount.
// Chrome can only discard a document that EXISTS off-screen; removing the
// iframe while the artifact is well out of view eliminates the blank-screen
// root cause. A 1.5-screen rootMargin keeps frames mounted a little beyond the
// edges (no flash on fast flick-past); we unload after a delay once fully out
// of the expanded region.
// ---------------------------------------------------------------------------

function unloadArtifactFrame(container) {
    if (!container || !LA_VIEWPORT_UNLOAD_ENABLED) return;
    // A still-streaming artifact is being written to right now — unloading it
    // would drop the stream. Side-panel frames and focused/interacted artifacts
    // stay mounted too.
    const frameShell = container.querySelector(':scope > .live-artifact-inline-frame');
    const viewport = frameShell?.querySelector('.live-artifact-inline-viewport');
    const frame = viewport?.querySelector('.live-artifact-inline-iframe');
    if (!frameShell || !frame) return;
    if (frame.dataset?.liveArtifactStreaming === 'true') return;
    if (container.closest('.live-artifacts-panel')) return;
    if (container.contains(document.activeElement)) return;

    // Cache the current rendered height so a later remount can restore it
    // synchronously (no layout jump when scrolling back).
    const currentHeight = parseInt(viewport?.style?.height || '', 10)
        || parseInt(frame.style?.height || '', 10)
        || 0;
    if (currentHeight > 0) {
        container.dataset.liveArtifactRestoreHeight = String(currentHeight);
    }
    container.dataset.liveArtifactFrameId = frame.dataset?.liveArtifactFrameId || '';
    container.dataset.artifactUnloaded = '1';
    // Cancel any in-flight final-height sweep so it cannot fire against the
    // now-detached frame (Phase 4 leak/cleanup).
    clearFinalHeightSweeps(frame);
    frameShell.remove();
}

function remountArtifactFrame(container) {
    if (!container) return;
    delete container.dataset.artifactUnloaded;
    // Resolve the artifact from the registry via the frame id stored at unload.
    const frameId = container.dataset.liveArtifactFrameId || '';
    const artifact = frameId ? registry.get(frameId) : null;
    if (artifact) {
        renderInlineArtifactFrame(container, artifact);
    } else {
        container.dataset.artifactUnloaded = '0';
    }
}

function scheduleArtifactUnload(container) {
    if (!LA_VIEWPORT_UNLOAD_ENABLED || !container) return;
    const existing = unloadTimers.get(container);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        unloadTimers.delete(container);
        unloadArtifactFrame(container);
    }, LA_UNLOAD_DELAY_MS);
    unloadTimers.set(container, timer);
}

function cancelArtifactUnload(container) {
    const existing = unloadTimers.get(container);
    if (existing) {
        clearTimeout(existing);
        unloadTimers.delete(container);
    }
}

function onViewportIntersection(entries) {
    if (!LA_VIEWPORT_UNLOAD_ENABLED) return;
    entries.forEach((entry) => {
        const container = entry.target;
        if (entry.isIntersecting) {
            cancelArtifactUnload(container);
            if (container.dataset.artifactUnloaded === '1') {
                remountArtifactFrame(container);
            }
        } else {
            scheduleArtifactUnload(container);
        }
    });
}

function observeArtifactViewportContainer(container) {
    if (!viewportUnloadObserver || !container) return;
    // Lazy cleanup: containers that left the DOM (session switch, chat cleared)
    // are already auto-unobserved by the IO, but drop them from the Set so the
    // Set does not hold references and keep the unload observer lean.
    observedViewportContainers.forEach((c) => {
        if (!c.isConnected) observedViewportContainers.delete(c);
    });
    if (observedViewportContainers.has(container)) return;
    observedViewportContainers.add(container);
    viewportUnloadObserver.observe(container);
}

function unobserveAllArtifactViewports() {
    if (viewportUnloadObserver) {
        observedViewportContainers.forEach((container) => {
            cancelArtifactUnload(container);
            viewportUnloadObserver.unobserve(container);
        });
    }
    observedViewportContainers.clear();
}

function initViewportUnloadObserver() {
    if (viewportUnloadObserver || !('IntersectionObserver' in window)) return;
    viewportUnloadObserver = new IntersectionObserver(onViewportIntersection, {
        rootMargin: '150% 0px',
    });
}

function pingAndRebuildArtifactFrame(frame, timeoutMs = FRAME_PING_TIMEOUT_MS) {
    if (!frame || typeof document === 'undefined') return;
    const frameId = frame.dataset?.liveArtifactFrameId || '';
    if (!frameId || !frame.isConnected) return;

    let alive = false;
    const onMessage = (event) => {
        const data = event?.data;
        if (!data || data.channel !== 'justsearch-live-artifacts' || data.event !== 'pong') return;
        if (String(data.frameId || '') === frameId) alive = true;
    };
    window.addEventListener('message', onMessage);

    try {
        frame.contentWindow?.postMessage({ channel: 'justsearch-live-artifacts', event: 'ping', frameId }, '*');
    } catch { /* frame messaging may fail while mounting */ }

    setTimeout(() => {
        window.removeEventListener('message', onMessage);
        if (alive || !frame.isConnected) return;
        // A frame still mounting its first document is not "dead" — give it time.
        const mountedAt = Number(frame.dataset?.liveArtifactMountedAt || 0);
        if (mountedAt && Date.now() - mountedAt < 2500 && !frame.dataset.liveArtifactLoaded) return;
        if (frame.classList.contains('live-artifacts-frame')) {
            recoverPanelFrame(frame);
        } else {
            recreateLiveArtifactFrame(frame);
        }
    }, timeoutMs);
}

function initLiveArtifactVisibilityRecovery() {
    if (visibilityRecoveryInitialized || typeof document === 'undefined') return;
    if (typeof window !== 'undefined' && window.__liveArtifactVisibilityRecoveryInitialized) return;
    visibilityRecoveryInitialized = true;
    if (typeof window !== 'undefined') {
        window.__liveArtifactVisibilityRecoveryInitialized = true;
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        // Phase 3: push the latest content to any frame that accumulated changes
        // while hidden (postInlineArtifactStream skipped the postMessages).
        flushDirtyArtifactFrames();
        // After any background stay Chrome may have discarded the in-viewport
        // srcdoc documents. Ping only those (Phase 2.2 already unmounted the
        // off-screen ones) with a short 300ms window so a dead frame is
        // replaced almost immediately.
        pingAndRebuildDeadArtifactFrames({
            timeoutMs: FRAME_WAKE_RECOVERY_TIMEOUT_MS,
            viewportOnly: true,
        });
    });

    if (typeof window !== 'undefined') {
        window.addEventListener('pageshow', (event) => {
            if (event && event.persisted) {
                pingAndRebuildDeadArtifactFrames({
                    timeoutMs: FRAME_WAKE_RECOVERY_TIMEOUT_MS,
                    viewportOnly: true,
                });
            }
        });
        document.addEventListener('resume', () => {
            pingAndRebuildDeadArtifactFrames({
                timeoutMs: FRAME_WAKE_RECOVERY_TIMEOUT_MS,
                viewportOnly: true,
            });
        });
        // Rolling a Live Artifact back into view is where Chrome most often
        // drops off-screen srcdoc documents while the page stays foregrounded
        // (JustSearch renders all messages statically; AMC unloads off-screen
        // messages via Virtuoso, so it never keeps an off-screen iframe alive).
        // Ping only the frame that just entered the viewport — and give the
        // viewport a small rootMargin head-start so a quick flick-past does
        // not leave a blank artifact waiting for the next intersection.
        if ('IntersectionObserver' in window) {
            // Phase 2.2: off-screen unloading. One observer watches the viewport
            // CONTAINERS and unloads / remounts them. A 1.5-screen rootMargin
            // keeps frames mounted a little beyond the edges so a quick
            // flick-past does not rebuild; leaving the expanded region schedules
            // a delayed unload (see onViewportIntersection).
            initViewportUnloadObserver();
            const startObservingViewports = () => {
                document.querySelectorAll('.live-artifact-inline-frame')
                    .forEach((container) => observeArtifactViewportContainer(container));
            };
            startObservingViewports();

            // A frame entering the viewport still gets a fast recovery check
            // (150ms here, 300ms for full-page wakes below): healthy frames answer
            // pong synchronously and are never rebuilt; a frame whose document
            // Chrome discarded (memory pressure / background stay) is rebuilt
            // almost immediately — the "whole artifact is white when I scroll
            // back" case, even when unload did not kick in.
            const observer = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        pingAndRebuildArtifactFrame(entry.target, FRAME_VIEW_RECOVERY_TIMEOUT_MS);
                    }
                });
            }, { rootMargin: '200px 0px 200px 0px' });
            // Observe existing frames plus any created later.
            const startObserving = () => {
                document.querySelectorAll('.live-artifact-inline-iframe, .live-artifacts-frame')
                    .forEach((frame) => observer.observe(frame));
            };
            startObserving();
            new MutationObserver(() => {
                document.querySelectorAll('.live-artifact-inline-iframe, .live-artifacts-frame')
                    .forEach((frame) => observer.observe(frame));
            }).observe(document.body, { childList: true, subtree: true });
        }

        // Scroll-stop sweep: IntersectionObserver fires when a frame crosses into
        // view, but a frame can stay in the viewport the whole time and still have
        // its document discarded under memory pressure (a 20k-px srcdoc iframe is
        // the top candidate). IO does not re-fire for an element that never leaves
        // the viewport, so after a scroll settles we ping every in-viewport frame
        // and rebuild the dead ones. Debounced so a long continuous scroll does not
        // hammer the pings.
        let scrollSettleTimer = null;
        window.addEventListener('scroll', () => {
            if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
            scrollSettleTimer = setTimeout(() => {
                scrollSettleTimer = null;
                const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
                if (!viewportHeight) return;
                document.querySelectorAll('.live-artifact-inline-iframe, .live-artifacts-frame')
                    .forEach((frame) => {
                        const rect = frame.getBoundingClientRect();
                        if (rect.bottom < -200 || rect.top > viewportHeight + 200) return;
                        pingAndRebuildArtifactFrame(frame, FRAME_VIEW_RECOVERY_TIMEOUT_MS);
                    });
            }, 400);
        }, { passive: true });
    }
}

/**
 * Chrome can tear down the nested browsing context of dynamically assigned
 * srcdoc iframes while a tab is in the background (Memory/Energy Saver, or
 * after sleep). The outer page survives — the frame keeps its srcdoc
 * attribute but renders blank until re-navigated. Rebuild every Live
 * Artifact frame from the in-memory registry instead of forcing a reload.
 */
export function rebuildLiveArtifactFrames() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('.live-artifact-inline-iframe').forEach((frame) => {
        recreateLiveArtifactFrame(frame);
    });
    recoverPanelFrame(panelState?.frame);
}

/**
 * Replace an iframe with a brand-new node carrying the same state. A new node
 * gets a new browsing context, which is the reliable way to revive a frame
 * whose srcdoc document Chrome has discarded in the background — re-assigning
 * srcdoc on the same element often cannot bring it back.
 */
function recreateLiveArtifactFrame(frame) {
    const frameId = frame.dataset?.liveArtifactFrameId || '';
    const artifact = frameId ? registry.get(frameId) : null;

    let srcdoc = '';
    if (artifact?.renderable) {
        ensureArtifactSrcdocTheme(artifact);
        srcdoc = artifact.srcdoc || '';
    }
    if (!srcdoc) {
        srcdoc = frame.srcdoc || frame.getAttribute?.('srcdoc') || '';
    }
    if (!srcdoc) return false;

    const viewport = frame.closest('.live-artifact-inline-viewport');
    if (!viewport) return false;
    const container = viewport.closest('.live-artifact-inline-frame')?.parentElement || null;

    const fresh = createLiveArtifactFrameNode(viewport, container);
    Object.assign(fresh.dataset, frame.dataset); // 继承高度/stream 等状态
    delete fresh.dataset.liveArtifactLoaded;
    fresh.dataset.liveArtifactMountedAt = String(Date.now());
    if (frame.style.height) fresh.style.height = frame.style.height;

    // Cancel any pending final-height sweep on the old node (Phase 4 cleanup).
    clearFinalHeightSweeps(frame);
    frame.replaceWith(fresh); // 新节点 = 新浏览上下文
    fresh.srcdoc = buildReloadSrcdoc(srcdoc);

    if (artifact?.isStreaming) syncPendingStreamToFrame(fresh, artifact);
    return true;
}

/**
 * Ping every open Live Artifact iframe's in-document bridge. Frames that do not
 * answer `pong` within timeoutMs have had their document discarded (background
 * tab / Memory Saver / freeze) and are rebuilt as brand-new nodes. Healthy
 * frames answer and are left completely untouched, so quick tab switches never
 * cause a flash. With `viewportOnly`, only frames currently inside the viewport
 * are pinged — after Phase 2.2 off-screen artifacts have no iframe at all, so
 * this is a pure safety net for frames discarded while the page stays visible.
 */
function pingAndRebuildDeadArtifactFrames({ timeoutMs = FRAME_PING_TIMEOUT_MS, viewportOnly = false } = {}) {
    if (typeof document === 'undefined') return;
    let frames = Array.from(document.querySelectorAll('.live-artifact-inline-iframe'));
    if (viewportOnly && frames.length) {
        const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
        frames = frames.filter((frame) => {
            if (!viewportHeight) return true;
            const rect = frame.getBoundingClientRect();
            return rect.bottom >= -200 && rect.top <= viewportHeight + 200;
        });
    }
    const panelFrame = (panelState?.frame && activeArtifactId) ? panelState.frame : null;
    const targets = panelFrame ? [...frames, panelFrame] : frames;
    if (!targets.length) return;

    const alive = new Set();
    const onMessage = (event) => {
        const data = event?.data;
        if (!data || data.channel !== 'justsearch-live-artifacts' || data.event !== 'pong') return;
        const frameId = String(data.frameId || '');
        if (frameId) alive.add(frameId);
    };
    window.addEventListener('message', onMessage);

    targets.forEach((frame) => {
        const frameId = frame.dataset?.liveArtifactFrameId || (frame === panelFrame ? activeArtifactId : '');
        if (!frameId) return;
        try {
            frame.contentWindow?.postMessage({ channel: 'justsearch-live-artifacts', event: 'ping', frameId }, '*');
        } catch { /* frame messaging may fail while mounting */ }
    });

    setTimeout(() => {
        window.removeEventListener('message', onMessage);
        const now = Date.now();
        targets.forEach((frame) => {
            const frameId = frame.dataset?.liveArtifactFrameId || (frame === panelFrame ? activeArtifactId : '');
            if (!frameId || alive.has(frameId) || !frame.isConnected) return;
            // 还在首次加载中的新 frame 不算死，避免误重建
            const mountedAt = Number(frame.dataset?.liveArtifactMountedAt || 0);
            if (mountedAt && now - mountedAt < 2500 && !frame.dataset.liveArtifactLoaded) return;
            if (frame === panelFrame) {
                recoverPanelFrame(panelFrame);
            } else {
                recreateLiveArtifactFrame(frame);
            }
        });
    }, timeoutMs);
}

/**
 * Re-assign srcdoc even when the value matches — Chrome may keep the
 * attribute while discarding the inner document. Appending an inert
 * timestamp comment guarantees a fresh navigation without a blank flash
 * and without mutating the registry's clean srcdoc.
 */
function buildReloadSrcdoc(srcdoc) {
    return `${srcdoc}\n<!-- live-artifact-reload ${Date.now()} -->`;
}

function forceReloadIframeDocument(frame, srcdoc) {
    if (!srcdoc) return;
    frame.srcdoc = buildReloadSrcdoc(srcdoc);
}

/**
 * Revive the single panel Live Artifact frame (not an inline message frame)
 * from the registry after its srcdoc document was discarded in the background.
 */
function recoverPanelFrame(panelFrame) {
    if (!panelFrame || !activeArtifactId) return;
    const artifact = registry.get(activeArtifactId);
    if (!artifact?.renderable) return;
    ensureArtifactSrcdocTheme(artifact);
    if (artifact.srcdoc) {
        forceReloadIframeDocument(panelFrame, artifact.srcdoc);
        syncPendingStreamToFrame(panelFrame, artifact);
    }
}

export const __liveArtifactsTestHooks = {
    adaptArtifactHtmlForTheme,
    applyInlineArtifactFrameHeight,
    buildArtifactCode,
    buildPreviewBaseFontSizeStyle,
    buildPreviewThemeStyle,
    buildSrcdoc,
    clampLiveArtifactFontSize,
    coerceLiveModeArtifact,
    ensureArtifactSrcdocTheme,
    extractCodeBlocks,
    extractInlineLiveArtifact,
    extractLiveArtifactInteraction,
    extractLiveArtifacts,
    findArtifactFrameByMessage,
    findArtifactFrameByMessageSource,
    forceOpenAllDetailsInHtml,
    forceReloadIframeDocument,
    flushDirtyArtifactFrames,
    handleArtifactFrameMessage,
    injectPreviewBaseFontSize,
    injectPreviewBaseStyles,
    injectPreviewTheme,
    injectPreviewSecurityPolicy,
    inferRenderableLanguage,
    linkArtifactCitationsInHtml,
    mapHardcodedColorForDarkTheme,
    materializeLiveArtifactThemeVars,
    measureArtifactContentHeight,
    normalizePreviewDiagnostic,
    normalizePreviewableMarkdownContent,
    parseLiveArtifactInteractionSpec,
    parseInfoAttributes,
    prefersHtmlArtifactPath,
    pingAndRebuildArtifactFrame,
    pingAndRebuildDeadArtifactFrames,
    processArtifactHtmlForDisplay,
    rebuildLiveArtifactFrames,
    recreateLiveArtifactFrame,
    remountArtifactFrame,
    resolveLiveArtifactFontSizePx,
    resolveLiveArtifactThemeId,
    resolveLiveArtifactsModeFlag,
    sanitizeClippingStylesInHtml,
    scheduleFinalHeightSweep,
    scheduleArtifactUnload,
    shouldMergeSupportingBlocks,
    syncInlineArtifactFrameHeight,
    unloadArtifactFrame,
    finalHeightSweepTimers,
    wrapAsArtifactRoot,
};

initLiveArtifactVisibilityRecovery();

