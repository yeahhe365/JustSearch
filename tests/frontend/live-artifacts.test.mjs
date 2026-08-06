import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
    getInlineLiveArtifact,
    renderLiveArtifactsForMessage,
    __liveArtifactsTestHooks,
} from '../../backend/static/js/modules/live-artifacts.js';

const {
    applyInlineArtifactFrameHeight,
    buildSrcdoc,
    clampLiveArtifactFontSize,
    coerceLiveModeArtifact,
    extractInlineLiveArtifact,
    extractLiveArtifactInteraction,
    extractLiveArtifacts,
    handleArtifactFrameMessage,
    adaptArtifactHtmlForTheme,
    injectPreviewBaseFontSize,
    injectPreviewBaseStyles,
    injectPreviewTheme,
    injectPreviewSecurityPolicy,
    linkArtifactCitationsInHtml,
    measureArtifactContentHeight,
    normalizePreviewDiagnostic,
    normalizePreviewableMarkdownContent,
    parseLiveArtifactInteractionSpec,
    sanitizeClippingStylesInHtml,
    scheduleFinalHeightSweep,
    forceOpenAllDetailsInHtml,
    resolveLiveArtifactsModeFlag,
    rebuildLiveArtifactFrames,
    syncInlineArtifactFrameHeight,
    finalHeightSweepTimers,
} = __liveArtifactsTestHooks;

const require = createRequire(import.meta.url);

function installBrowserGlobals(html = '<!doctype html><body></body>') {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(html, { url: 'http://localhost/' });

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.Element = dom.window.Element;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.HTMLInputElement = dom.window.HTMLInputElement;
    globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
    globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
    globalThis.NodeFilter = dom.window.NodeFilter;
    globalThis.history = dom.window.history;
    globalThis.location = dom.window.location;
    // chat.js batches stream renders on rAF; jsdom does not provide it by default.
    const raf = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.requestAnimationFrame = raf;
    dom.window.requestAnimationFrame = raf;
    if (!dom.window.HTMLElement.prototype.scrollTo) {
        dom.window.HTMLElement.prototype.scrollTo = function scrollTo(options = {}) {
            if (typeof options === 'object' && options !== null && Number.isFinite(options.top)) {
                this.scrollTop = options.top;
            }
        };
    }
    Object.defineProperty(globalThis, 'navigator', {
        value: dom.window.navigator,
        configurable: true,
    });
    window.markdownit = () => ({
        render: value => String(value || ''),
        utils: { escapeHtml: value => String(value || '') },
    });
    globalThis.MessageEvent = dom.window.MessageEvent;
    window.DOMPurify = { sanitize: value => String(value || '') };
    window.hljs = { getLanguage: () => false };
    window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

    return dom;
}

test('complete HTML blocks are treated as self-contained Live Artifacts', () => {
    const markdown = [
        '```css',
        'body { background: red; }',
        '```',
        '```html',
        '<!DOCTYPE html>',
        '<html>',
        '<head><title>Live Artifacts Prompt</title><style>body { color: #111; }</style></head>',
        '<body><main>Ready</main><script>window.ready = true;</script></body>',
        '</html>',
        '```',
        '```js',
        'window.extra = true;',
        '```',
    ].join('\n');

    const artifacts = extractLiveArtifacts(markdown, 'message-a');

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].title, 'Live Artifacts Prompt');
    assert.equal(artifacts[0].language, 'html');
    assert.deepEqual(artifacts[0].supportBlockIndices, []);
    assert.match(artifacts[0].code, /<!DOCTYPE html>/i);
    assert.doesNotMatch(artifacts[0].code, /window\.extra/);
    assert.doesNotMatch(artifacts[0].code, /background:\s*red/);
});

test('artifact titles strip hostile markup without DOM parsing', () => {
    installBrowserGlobals();
    const originalCreateElement = document.createElement.bind(document);
    let createElementCalls = 0;
    document.createElement = () => {
        createElementCalls += 1;
        throw new Error('title extraction should not parse DOM nodes');
    };

    try {
        const markdown = [
            '```html',
            '<!doctype html>',
            '<html>',
            '<head><title><img src=x onerror=alert(1)>Safe &amp; Sound &#x1F4A1;</title></head>',
            '<body>Ready</body>',
            '</html>',
            '```',
        ].join('\n');
        const artifacts = extractLiveArtifacts(markdown, 'message-hostile-title');

        assert.equal(artifacts.length, 1);
        assert.equal(artifacts[0].title, 'Safe & Sound 💡');
        assert.equal(createElementCalls, 0);
    } finally {
        document.createElement = originalCreateElement;
    }
});

test('AMC-style raw inline HTML fragments render as inline Live Artifact frames', () => {
    const html = '<section style="display:grid"><strong>Inline Artifact</strong></section>';
    const artifact = extractInlineLiveArtifact(html, 'message-inline', false);

    assert.ok(artifact);
    assert.equal(artifact.inline, true);
    assert.equal(artifact.language, 'html');
    assert.match(artifact.srcdoc, /Inline Artifact/);
    assert.match(artifact.srcdoc, /justsearch-live-artifacts/);
});

test('normalizePreviewableMarkdownContent wraps bare HTML like AMC', () => {
    const html = '<section><h2>Hello</h2><p>World</p></section>';
    const normalized = normalizePreviewableMarkdownContent(html);
    assert.match(normalized, /```amc-live-artifact-html/);
    assert.match(normalized, /<section>/);
});

test('sanitizeClippingStylesInHtml removes viewport shells that cause thin bars', () => {
    const raw = '<div style="height:100vh;max-height:100%;overflow:hidden;color:red">Score</div>';
    const cleaned = sanitizeClippingStylesInHtml(raw);
    assert.match(cleaned, /height:\s*auto/i);
    assert.match(cleaned, /max-height:\s*none/i);
    assert.match(cleaned, /overflow:\s*visible/i);
    assert.match(cleaned, /Score/);
});

test('sanitizeClippingStylesInHtml preserves intentional scroll containers', () => {
    // Regression: overflow-y:auto/scroll must NOT be rewritten to visible — that
    // breaks artifacts with deliberate scrollable panels.
    const raw = '<div style="height:300px;overflow-y:auto">log lines</div>';
    const cleaned = sanitizeClippingStylesInHtml(raw);
    assert.match(cleaned, /overflow-y:\s*auto/i);
    assert.match(cleaned, /log lines/);
    // overflow:hidden (the actual clip failure) is still neutralized.
    const clipped = sanitizeClippingStylesInHtml('<div style="overflow:hidden">x</div>');
    assert.match(clipped, /overflow:\s*visible/i);
});

test('forceOpenAllDetailsInHtml does not corrupt custom elements like <details-panel>', () => {
    // Regression: the old <details\b regex turned <details-panel> into <details open-panel>.
    const html = '<details-panel>hi</details-panel><details><summary>m</summary><p>x</p></details>';
    const out = forceOpenAllDetailsInHtml(html);
    assert.match(out, /<details-panel>hi<\/details-panel>/);
    assert.doesNotMatch(out, /<details open-panel/);
    // Real <details> still gets forced open.
    assert.match(out, /<details open>/);
});

test('resolveLiveArtifactsModeFlag falls back to global state for explicit undefined', () => {
    installBrowserGlobals();
    // Simulate global mode on; an explicit undefined must fall back, not disable.
    const orig = typeof window !== 'undefined' && window.state ? window.state.liveArtifactsMode : undefined;
    assert.equal(resolveLiveArtifactsModeFlag({ liveArtifactsMode: undefined }), Boolean(orig));
    assert.equal(resolveLiveArtifactsModeFlag({ liveArtifactsMode: false }), false);
    assert.equal(resolveLiveArtifactsModeFlag({ liveArtifactsMode: true }), true);
    assert.equal(resolveLiveArtifactsModeFlag({}), Boolean(orig));
});

test('handleArtifactFrameMessage never shrinks when all details collapse', () => {
    // New contract (content-clipping fix): bridge resize never shrinks, so a
    // single under-report (here: all-details-collapsed, small content height)
    // cannot clip the previously-seeded viewport. Content stays visible; the
    // next probe pass restores the accurate height.
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div class="live-artifact-inline-viewport" style="height:1108px">
                <iframe
                  class="live-artifact-inline-iframe"
                  style="height:1108px"
                  data-live-artifact-frame-id="collapse-frame-1"
                  data-live-artifact-collapsed-height="522"
                  data-live-artifact-expanded-height="1100"
                  data-live-artifact-has-details="true"
                ></iframe>
            </div>
        </body>
    `);
    const viewport = document.querySelector('.live-artifact-inline-viewport');
    const frame = document.querySelector('.live-artifact-inline-iframe');
    Object.defineProperty(frame, 'contentWindow', {
        configurable: true,
        value: { id: 'mock-collapse-frame' },
    });
    // Bridge reports all details collapsed and a small content height.
    handleArtifactFrameMessage({
        source: frame.contentWindow,
        data: {
            channel: 'justsearch-live-artifacts',
            event: 'resize',
            height: 540,
            openDetailsCount: 0,
            totalDetailsCount: 2,
            detailsOpen: false,
            frameId: 'collapse-frame-1',
        },
    });
    // Must NOT shrink below the seeded 1108 — content stays fully visible.
    const h = parseInt(viewport.style.height, 10);
    assert.ok(h >= 1100, `expected no shrink below 1100, got ${h}`);
});

test('liveArtifactsMode coerces Markdown answers into a single themed iframe artifact', () => {
    installBrowserGlobals();
    window.markdownit = () => ({
        render: (value) => {
            const text = String(value || '');
            if (text.includes('梅西')) {
                return '<h2>梅西下一场比赛</h2><table><tr><td>对阵</td><td>英格兰</td></tr></table><div style="height:100vh;overflow:hidden">实时积分</div>';
            }
            return text;
        },
    });
    window.DOMPurify = {
        sanitize: (value) => String(value || ''),
    };

    const markdown = [
        '## 梅西下一场比赛核心信息',
        '',
        '根据公开来源，下一场为半决赛。',
        '',
        '| 项目 | 内容 |',
        '| --- | --- |',
        '| 对阵双方 | 阿根廷 vs 英格兰 |',
        '',
        '<div style="height:100vh;overflow:hidden">实时积分情况</div>',
    ].join('\n');

    const artifact = getInlineLiveArtifact(markdown, 'message-coerce-md', false, {
        liveArtifactsMode: true,
    });

    assert.ok(artifact, 'expected coerced live artifact');
    assert.equal(artifact.inline, true);
    assert.equal(artifact.coerced, true);
    assert.equal(artifact.coercedFrom, 'markdown');
    assert.match(artifact.code, /data-justsearch-live-artifact-root/);
    assert.match(artifact.code, /梅西下一场比赛/);
    assert.match(artifact.code, /实时积分/);
    // Clipping shells must be neutralized before srcdoc bake.
    assert.doesNotMatch(artifact.code, /height:\s*100vh/i);
    assert.match(artifact.srcdoc, /--amc-live-artifact-text|--amc-live-artifact-font-size|justsearch-live-artifacts/);
});

test('liveArtifactsMode off leaves pure Markdown as non-artifact', () => {
    const markdown = '## Title\n\nJust a paragraph with [1] cite.';
    const artifact = getInlineLiveArtifact(markdown, 'message-md-off', false, {
        liveArtifactsMode: false,
    });
    assert.equal(artifact, null);
});

test('coerceLiveModeArtifact wraps multi-root HTML under a single root', () => {
    const html = '<h2>A</h2><p>B</p><div style="overflow:hidden;max-height:100vh">C</div>';
    const artifact = coerceLiveModeArtifact(html, 'message-multi-root', { isStreaming: false });
    assert.ok(artifact);
    assert.equal(artifact.coercedFrom, 'html');
    assert.match(artifact.code, /data-justsearch-live-artifact-root/);
    assert.match(artifact.code, />C</);
    assert.doesNotMatch(artifact.code, /max-height:\s*100vh/i);
});

test('inline Live Artifact fragments can include scoped style blocks', () => {
    const html = '<style>.metric{color:#0f766e}</style><section class="metric"><strong>Styled</strong></section>';
    const artifact = extractInlineLiveArtifact(html, 'message-style', false);

    assert.ok(artifact);
    assert.equal(artifact.language, 'html');
    assert.match(artifact.srcdoc, /\.metric/);
    assert.equal(
        extractInlineLiveArtifact('<section><script>alert(1)</script></section>', 'message-script', false),
        null,
    );
});

test('streaming open HTML fences keep the pending artifact preview path', () => {
    const artifact = extractInlineLiveArtifact(
        '```html\n<section style="display:grid"><strong>Partial',
        'message-open-fence',
        true,
    );

    assert.ok(artifact);
    assert.equal(artifact.isStreaming, true);
    assert.match(artifact.streamHtml, /Partial/);
    // Streaming keeps a stable empty shell in srcdoc; markup rides streamHtml + postMessage.
    assert.match(artifact.streamHtml, /Partial/);
    assert.match(artifact.srcdoc, /data-amc-stream-preview-root="true"/);
    assert.match(artifact.srcdoc, /stream-render/);
    assert.doesNotMatch(artifact.srcdoc, /Partial/);
});

test('Live Artifact srcdoc uses AMC-style CSP and preview diagnostics', () => {
    const srcdoc = buildSrcdoc('<section><img src="https://example.invalid/missing.png"></section>', 'html');

    assert.match(srcdoc, /http-equiv="Content-Security-Policy"/);
    assert.match(srcdoc, /default-src 'none'/);
    assert.match(srcdoc, /frame-src 'none'/);
    assert.match(srcdoc, /form-action 'none'/);
    // Local HTTP deploy (127.0.0.1) and relative /static assets must not be blocked.
    assert.match(srcdoc, /img-src[^;]*http:/);
    assert.match(srcdoc, /img-src[^;]*https:/);
    assert.match(srcdoc, /font-src[^;]*http:/);
    assert.match(srcdoc, /connect-src[^;]*http:/);
    assert.match(srcdoc, /event: 'diagnostic'/);
    assert.match(srcdoc, /resource-error/);
    assert.match(srcdoc, /runtime-error/);
    assert.match(srcdoc, /csp-violation/);
    assert.match(srcdoc, /data-amc-preview-base/);
    assert.match(srcdoc, /data-amc-live-artifact-base-font-size/);
    assert.match(srcdoc, /data-amc-live-artifact-theme/);
    assert.match(srcdoc, /--amc-live-artifact-font-size:16px/);
    assert.match(srcdoc, /--amc-live-artifact-text:/);
    assert.match(srcdoc, /height:\s*auto\s*!important/);
    assert.match(srcdoc, /body > section/);
    assert.match(srcdoc, /notifyResize/);
    assert.match(srcdoc, /scheduleResize/);
    assert.match(srcdoc, /scheduleResizeBurst/);
    assert.match(srcdoc, /measureContentHeight/);
    assert.match(srcdoc, /HTMLDetailsElement/);
    assert.match(srcdoc, /addEventListener\('toggle'/);
    assert.match(srcdoc, /frameId: FRAME_ID/);
});

test('side panel body allows scroll when artifact is taller than viewport', () => {
    const fs = require('node:fs');
    const pathMod = require('node:path');
    const { fileURLToPath } = require('node:url');
    const cssPath = pathMod.resolve(
        pathMod.dirname(fileURLToPath(import.meta.url)),
        '../../backend/static/css/sections/live-artifacts.css',
    );
    const css = fs.readFileSync(cssPath, 'utf8');
    // Panel body must scroll; height-only flex child without overflow clips tall iframes.
    assert.match(css, /\.live-artifacts-panel-body\s*\{[^}]*overflow\s*:\s*auto/s);
});

test('Live Artifact srcdoc remeasures height when details toggle', () => {
    const srcdoc = buildSrcdoc(
        '<section><details><summary>more</summary><p>hidden body</p></details></section>',
        'html',
        [],
        { frameId: 'details-test' },
    );
    // Collapse chrome must not trap expanded content inside a fixed viewport shell.
    assert.match(srcdoc, /details\s*\{[\s\S]*overflow:\s*visible\s*!important/);
    assert.match(srcdoc, /scheduleResizeBurst/);
    assert.match(srcdoc, /details\[open\]/);
    // Preview forces details open so content is visible without postMessage resize.
    assert.match(srcdoc, /<details open/i);
    assert.match(srcdoc, /summary::before/);
});

test('Live Artifact srcdoc injects configured base font size', () => {
    const srcdoc = buildSrcdoc('<section><p>Hello</p></section>', 'html', [], {
        frameId: 'font-test',
        baseFontSize: 21,
    });
    assert.match(srcdoc, /--amc-live-artifact-font-size:21px/);
    assert.match(srcdoc, /font-size:var\(--amc-live-artifact-font-size\)/);
    assert.equal(clampLiveArtifactFontSize(99), 32);
    assert.equal(clampLiveArtifactFontSize(3), 10);
    assert.equal(clampLiveArtifactFontSize('nope'), 16);

    const once = injectPreviewBaseFontSize(srcdoc, 18);
    assert.equal(once, srcdoc, 'font-size style is only injected once');
});

test('Live Artifact srcdoc injects light and dark theme tokens', () => {
    const light = buildSrcdoc('<section><p>Hello</p></section>', 'html', [], {
        frameId: 'theme-light',
        themeId: 'light',
    });
    assert.match(light, /data-amc-live-artifact-theme="true"/);
    assert.match(light, /color-scheme:light/);
    assert.match(light, /--amc-live-artifact-text:#111827/);
    assert.match(light, /--amc-live-artifact-surface:#f3f4f6/);
    assert.match(light, /--amc-live-artifact-accent:#2563eb/);
    assert.match(light, /background:transparent!important/);
    assert.match(light, /color:#111827!important/);

    const dark = buildSrcdoc('<section><p>Hello</p></section>', 'html', [], {
        frameId: 'theme-dark',
        themeId: 'dark',
    });
    assert.match(dark, /color-scheme:dark/);
    assert.match(dark, /--amc-live-artifact-text:#f4f4f5/);
    assert.match(dark, /--amc-live-artifact-surface:#18181b/);
    assert.match(dark, /--amc-live-artifact-border:#27272a/);
    assert.match(dark, /--amc-live-artifact-accent:#38bdf8/);
    assert.match(dark, /--amc-live-artifact-muted:#a1a1aa/);
    assert.match(dark, /color:#f4f4f5!important/);

    const once = injectPreviewTheme(dark, 'light');
    assert.equal(once, dark, 'theme style is only injected once');
});

test('dark theme rewrites hardcoded light-mode inline colors', () => {
    const html = `
      <div style="display:block;width:100%">
        <h2 style="margin:0;font-weight:600">Title</h2>
        <div style="background:#f5f9ff;border-left:4px solid #2196f3;color:#0d47a1">callout</div>
        <p style="color:#666">muted note</p>
        <table><tr style="background:#f0f0f0"><th style="border-bottom-color:#ddd">H</th></tr></table>
        <div style="background:#fff3e0">warn</div>
      </div>
    `;
    const adapted = adaptArtifactHtmlForTheme(html, 'dark');
    // Pale near-white surfaces → dark surface / accent-surface tokens.
    assert.match(adapted, /background:\s*var\(--amc-live-artifact-(?:surface|accent-surface)\)/);
    assert.match(adapted, /color:\s*var\(--amc-live-artifact-accent\)/);
    assert.match(adapted, /color:\s*var\(--amc-live-artifact-muted\)/);
    assert.match(adapted, /border-bottom-color:\s*var\(--amc-live-artifact-border\)/);
    assert.match(adapted, /background:\s*var\(--amc-live-artifact-accent-surface\)/);

    const light = adaptArtifactHtmlForTheme(html, 'light');
    assert.match(light, /background:#f5f9ff/);
    assert.doesNotMatch(light, /--amc-live-artifact-surface/);

    const srcdoc = buildSrcdoc(html, 'html', [], { themeId: 'dark', frameId: 'adapt-1' });
    // Theme text is baked as concrete hex + !important on html/body (AMC-compatible).
    assert.match(srcdoc, /color:#f4f4f5!important/);
    assert.match(srcdoc, /#18181b/);
    assert.doesNotMatch(srcdoc, /background:#f5f9ff/);
});

test('dark theme materializes CSS variable tokens to concrete colors', () => {
    const html = `<div style="background:var(--amc-live-artifact-surface);color:var(--amc-live-artifact-text);border:1px solid var(--amc-live-artifact-border)">card</div>`;
    const dark = buildSrcdoc(html, 'html', [], { themeId: 'dark', frameId: 'mat-dark' });
    assert.match(dark, /background:\s*#18181b/);
    assert.match(dark, /color:\s*#f4f4f5/);
    assert.match(dark, /border:\s*1px solid #27272a/);
    // Unresolved light-looking surfaces must not remain.
    assert.doesNotMatch(dark, /background:\s*var\(--amc-live-artifact-surface\)/);
    assert.doesNotMatch(dark, /#f3f4f6/);

    const light = buildSrcdoc(html, 'html', [], { themeId: 'light', frameId: 'mat-light' });
    assert.match(light, /background:\s*#f3f4f6/);
    assert.match(light, /color:\s*#111827/);
});

test('preview base styles neutralize full-viewport height constraints', () => {
    const withHead = injectPreviewBaseStyles('<!doctype html><html><head><title>Demo</title></head><body><section>Tall</section></body></html>');
    assert.match(withHead, /<head><style data-amc-preview-base="true">/);
    assert.match(withHead, /max-height:\s*none\s*!important/);
    assert.match(withHead, /body > section/);
    assert.match(withHead, /<title>Demo<\/title>/);

    const fragment = injectPreviewBaseStyles('<section>Ready</section>');
    assert.match(fragment, /data-amc-preview-base="true"/);
    assert.match(fragment, /<section>Ready<\/section>/);

    const once = injectPreviewBaseStyles(withHead);
    assert.equal(once, withHead);
});

test('inline artifact srcdoc embeds stable frame id for resize routing', () => {
    const srcdoc = buildSrcdoc('<section>Tall content</section>', 'html', [], { frameId: 'msg-1-inline-0' });
    assert.match(srcdoc, /const FRAME_ID = "msg-1-inline-0"/);
    assert.match(srcdoc, /frameId: FRAME_ID/);
});

test('inline artifact resize applies height to both viewport and iframe', () => {
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div class="live-artifact-inline-viewport">
                <iframe class="live-artifact-inline-iframe"></iframe>
            </div>
        </body>
    `);

    const viewport = document.querySelector('.live-artifact-inline-viewport');
    const frame = document.querySelector('.live-artifact-inline-iframe');
    // Parent applies a small height pad so expanded details are not clipped.
    const applied = applyInlineArtifactFrameHeight(viewport, frame, 980.4);

    assert.equal(applied, 989);
    assert.equal(viewport.style.height, '989px');
    assert.equal(frame.style.height, '989px');
    assert.equal(viewport.style.minHeight, '120px');

    const floor = applyInlineArtifactFrameHeight(viewport, frame, 12);
    assert.equal(floor, 120);
    assert.equal(viewport.style.height, '120px');
    assert.equal(frame.style.height, '120px');

    applyInlineArtifactFrameHeight(viewport, frame, 800);
    const noShrink = applyInlineArtifactFrameHeight(viewport, frame, 200, { allowShrink: false });
    assert.equal(noShrink, 808);
    assert.equal(viewport.style.height, '808px');
});

test('parent-side height probe expands past short iframe defaults', () => {
    installBrowserGlobals();
    const longHtml = `<section style="display:block;width:100%"><h2>Title</h2>${
        Array.from({ length: 40 }, (_, i) => `<p>段落 ${i} ${'内容'.repeat(20)}</p>`).join('')
    }</section>`;
    const height = measureArtifactContentHeight(longHtml, 640);
    assert.ok(height > 320, `expected probed height > 320, got ${height}`);
});

test('parent-side height probe accepts forceOpenDetails option', () => {
    installBrowserGlobals();
    const html = `
      <div style="display:block;width:100%">
        <h2>Title</h2>
        <p>Intro paragraph for the collapsed baseline.</p>
        <details>
          <summary>More</summary>
          ${Array.from({ length: 25 }, (_, i) => `<p>Hidden row ${i} ${'x'.repeat(40)}</p>`).join('')}
        </details>
      </div>
    `;
    const collapsed = measureArtifactContentHeight(html, 640);
    const expanded = measureArtifactContentHeight(html, 640, { forceOpenDetails: true });
    // jsdom may not layout <details>; just require a stable finite height and non-throw.
    assert.ok(Number.isFinite(collapsed) && collapsed >= 120);
    assert.ok(Number.isFinite(expanded) && expanded >= collapsed);
});

test('probe injects bridge base styles so height matches the iframe environment', () => {
    // Content-clipping fix: the probe must measure with the same base CSS as the
    // iframe (PREVIEW_BASE_STYLES) or it systematically under-reports vs the
    // iframe's line-height 1.65 layout, seeding a viewport too short to hold
    // content that then gets clipped at <br>/<details> boundaries.
    installBrowserGlobals();
    const html = `<section style="display:block;width:100%"><h2>Title</h2>${
        Array.from({ length: 30 }, (_, i) => `<p>段落 ${i} ${'内容'.repeat(8)}</p>`).join('')
    }</section>`;
    const probe = document.querySelector('[data-amc-height-probe]'); // not yet appended
    assert.equal(probe, null);
    const height = measureArtifactContentHeight(html, 640);
    // Probe ran and was cleaned up (no leftover probe in the DOM).
    assert.equal(document.querySelector('[data-amc-height-probe]'), null);
    assert.ok(height > 320, `expected iframe-environment probe > 320, got ${height}`);
});

test('syncInlineArtifactFrameHeight probes hydrated HTML and never shrinks the seed', () => {
    // Content-clipping fix: the parent-side probe must measure the SAME HTML
    // srcdoc renders (sanitize→forceOpenDetails→linkCitations), and the seeded
    // viewport must never shrink (allowShrink:false) so the iframe can grow it
    // later. A second sync must not drop the height below the first.
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div class="live-artifact-inline-viewport" style="height:1400px"></div>
        </body>
    `);
    const viewport = document.querySelector('.live-artifact-inline-viewport');
    const frame = document.createElement('iframe');
    frame.className = 'live-artifact-inline-iframe';
    frame.style.height = '1400px';
    frame.dataset.liveArtifactFrameId = 'probe-parity-1';
    viewport.appendChild(frame);

    const artifact = {
        id: 'probe-parity-1',
        renderable: true,
        language: 'html',
        isStreaming: false,
        code: `<section style="display:block;width:100%"><h2>已知问题</h2>${
            Array.from({ length: 40 }, (_, i) => `<p>行 ${i} ${'内容'.repeat(12)}</p>`).join('')
        }<br><details><summary>📋 查看更多更新详情</summary>${
            Array.from({ length: 20 }, (_, i) => `<p>详情 ${i}</p>`).join('')
        }</details></section>`,
        sources: [{ id: 1, title: 'src', url: 'https://x.test' }],
    };
    const first = syncInlineArtifactFrameHeight(viewport, frame, artifact, viewport);
    assert.ok(first >= 120, `first probe must be finite, got ${first}`);
    const seededHeight = parseInt(viewport.style.height, 10);
    assert.ok(seededHeight >= 120, `viewport seeded with ${seededHeight}`);
    // Second sync (e.g. re-render) must never shrink below the first seed.
    const second = syncInlineArtifactFrameHeight(viewport, frame, artifact, viewport);
    const secondHeight = parseInt(viewport.style.height, 10);
    assert.ok(secondHeight >= seededHeight, `second sync shrank: ${seededHeight} -> ${secondHeight}`);
});

test('bridge scheduleResize has setTimeout fallback for background tabs', () => {
    // P0-1: a pure-rAF scheduleResize is suspended in background tabs, so the
    // resize message is never emitted and the viewport stays clipped. The
    // baked bridge script must carry a setTimeout(done, 120) fallback.
    const srcdoc = buildSrcdoc('<section>x</section>', 'html', [], { frameId: 't1' });
    assert.match(srcdoc, /resizeScheduled/);
    assert.match(srcdoc, /setTimeout\(done,\s*120\)/);
});

test('scheduleFinalHeightSweep registers a grow-only timer per frame', () => {
    // P0-2: after baking the final srcdoc, two delayed re-measures (allowShrink:false)
    // cover "seed measured short + bridge resize lost". The timer set must be
    // tracked on finalHeightSweepTimers so it can be cleared/replaced.
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div class="live-artifact-inline-viewport" style="height:320px"></div>
        </body>
    `);
    const viewport = document.querySelector('.live-artifact-inline-viewport');
    const frame = document.createElement('iframe');
    frame.className = 'live-artifact-inline-iframe';
    viewport.appendChild(frame);

    const artifact = {
        id: 'sweep-1',
        renderable: true,
        language: 'html',
        isStreaming: false,
        code: '<section style="display:block;width:100%"><h2>x</h2><p>body</p></section>',
        sources: [],
    };
    scheduleFinalHeightSweep(viewport, frame, artifact, viewport, 1000);
    const timers = finalHeightSweepTimers.get(frame);
    assert.ok(timers && timers.size === 1, `expected 1 sweep timer, got ${timers?.size}`);
});

test('resize message with unknown frameId warns and does not throw', () => {
    // P1-5 diagnostic: an unroutable resize must not crash the message handler.
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div class="live-artifact-inline-viewport">
                <iframe class="live-artifact-inline-iframe" data-live-artifact-frame-id="known-1"></iframe>
            </div>
        </body>
    `);
    const frame = document.querySelector('.live-artifact-inline-iframe');
    Object.defineProperty(frame, 'contentWindow', {
        configurable: true,
        value: { id: 'mock-diag-window' },
    });

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
        // No throw, even though 'no-such-frame' is not in the DOM.
        assert.doesNotThrow(() => handleArtifactFrameMessage({
            source: frame.contentWindow,
            data: {
                channel: 'justsearch-live-artifacts',
                event: 'resize',
                height: 999,
                frameId: 'no-such-frame',
            },
        }));
        assert.equal(warnings.length, 1);
        assert.match(String(warnings[0][0]), /resize 消息未找到目标 frame/);
    } finally {
        console.warn = originalWarn;
    }
});

test('details-toggle resize falls back to precomputed expanded height', () => {
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div class="live-artifact-inline-viewport" style="height:200px">
                <iframe
                  class="live-artifact-inline-iframe"
                  style="height:200px"
                  data-live-artifact-frame-id="details-frame-1"
                  data-live-artifact-collapsed-height="200"
                  data-live-artifact-expanded-height="900"
                  data-live-artifact-has-details="true"
                ></iframe>
            </div>
        </body>
    `);

    const viewport = document.querySelector('.live-artifact-inline-viewport');
    const frame = document.querySelector('.live-artifact-inline-iframe');
    Object.defineProperty(frame, 'contentWindow', {
        configurable: true,
        value: { id: 'mock-details-frame' },
    });

    // Bridge under-reports height (classic fixed-iframe chicken-and-egg).
    handleArtifactFrameMessage({
        source: frame.contentWindow,
        data: {
            channel: 'justsearch-live-artifacts',
            event: 'resize',
            height: 210,
            detailsToggle: true,
            detailsOpen: true,
            openDetailsCount: 1,
            totalDetailsCount: 1,
            frameId: 'details-frame-1',
        },
    });

    assert.equal(viewport.style.height, '908px');
    assert.equal(frame.style.height, '908px');
});

test('under-reported resize never collapses to first-summary height for details artifacts', () => {
    // Regression: bridge scrollHeight ≈ collapsed clipped open details content.
    // New contract (content-clipping fix): bridge resize never shrinks, so an
    // under-report is held at the expanded floor (1100 + pad) — content stays.
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div class="live-artifact-inline-viewport" style="height:2138px">
                <iframe
                  class="live-artifact-inline-iframe"
                  style="height:2138px"
                  data-live-artifact-frame-id="details-floor-1"
                  data-live-artifact-collapsed-height="522"
                  data-live-artifact-expanded-height="1100"
                  data-live-artifact-has-details="true"
                ></iframe>
            </div>
        </body>
    `);

    const viewport = document.querySelector('.live-artifact-inline-viewport');
    const frame = document.querySelector('.live-artifact-inline-iframe');
    Object.defineProperty(frame, 'contentWindow', {
        configurable: true,
        value: { id: 'mock-floor-frame' },
    });

    handleArtifactFrameMessage({
        source: frame.contentWindow,
        data: {
            channel: 'justsearch-live-artifacts',
            event: 'resize',
            height: 522,
            frameId: 'details-floor-1',
        },
    });

    // Expanded floor (1100) + pad keeps content from being clipped to summary-only.
    const h = parseInt(viewport.style.height, 10);
    assert.ok(h >= 1100, `expected no collapse below expanded floor 1100, got ${h}`);
});

test('trusted bridge resize holds inflated height instead of shrinking', () => {
    // New contract (content-clipping fix): a single bridge resize never shrinks,
    // even when the iframe measured real content shorter than the parent probe.
    // The old behavior (shrink-to-remove-blank-space) clipped content when the
    // bridge's measure was itself stale/early. Overshoot is corrected on the
    // next probe pass, not by a shrink here.
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div class="live-artifact-inline-viewport" style="height:2146px">
                <iframe
                  class="live-artifact-inline-iframe"
                  style="height:2146px"
                  data-live-artifact-frame-id="details-shrink-1"
                  data-live-artifact-collapsed-height="522"
                  data-live-artifact-expanded-height="2138"
                  data-live-artifact-has-details="true"
                ></iframe>
            </div>
        </body>
    `);

    const viewport = document.querySelector('.live-artifact-inline-viewport');
    const frame = document.querySelector('.live-artifact-inline-iframe');
    Object.defineProperty(frame, 'contentWindow', {
        configurable: true,
        value: { id: 'mock-shrink-frame' },
    });

    handleArtifactFrameMessage({
        source: frame.contentWindow,
        data: {
            channel: 'justsearch-live-artifacts',
            event: 'resize',
            height: 980,
            openDetailsCount: 2,
            totalDetailsCount: 2,
            detailsOpen: true,
            frameId: 'details-shrink-1',
        },
    });

    // No shrink: holds at the seeded 2146 so content stays visible.
    const h = parseInt(viewport.style.height, 10);
    assert.ok(h >= 2138, `expected no shrink below 2138, got ${h}`);
    // Trusted iframe measure still updates the expanded-floor datum for later probes.
    assert.equal(frame.dataset.liveArtifactExpandedHeight, '980');
});

test('resize postMessage from inline frame grows the clipped viewport', () => {
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div class="live-artifact-inline-viewport" style="height:120px">
                <iframe class="live-artifact-inline-iframe" style="height:120px" data-live-artifact-frame-id="stream-abc-inline-0"></iframe>
            </div>
        </body>
    `);

    const viewport = document.querySelector('.live-artifact-inline-viewport');
    const frame = document.querySelector('.live-artifact-inline-iframe');
    // Pretend this is the message source window for the trusted-frame lookup path.
    Object.defineProperty(frame, 'contentWindow', {
        configurable: true,
        value: { id: 'mock-inline-frame-window' },
    });

    handleArtifactFrameMessage({
        source: frame.contentWindow,
        data: {
            channel: 'justsearch-live-artifacts',
            event: 'resize',
            height: 1560,
        },
    });

    assert.equal(viewport.style.height, '1568px');
    assert.equal(frame.style.height, '1568px');
});

test('resize postMessage can route by frameId without contentWindow match', () => {
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div class="live-artifact-inline-viewport" style="height:120px">
                <iframe class="live-artifact-inline-iframe" style="height:120px" data-live-artifact-frame-id="stream-xyz-inline-0"></iframe>
            </div>
        </body>
    `);

    const viewport = document.querySelector('.live-artifact-inline-viewport');
    const frame = document.querySelector('.live-artifact-inline-iframe');

    handleArtifactFrameMessage({
        source: { id: 'unrelated-window' },
        data: {
            channel: 'justsearch-live-artifacts',
            event: 'resize',
            height: 2400,
            frameId: 'stream-xyz-inline-0',
        },
    });

    assert.equal(viewport.style.height, '2408px');
    assert.equal(frame.style.height, '2408px');
});

test('Live Artifact CSP injection preserves existing document heads', () => {
    const srcdoc = injectPreviewSecurityPolicy('<!doctype html><html><head><title>Demo</title></head><body>Ready</body></html>');

    assert.match(srcdoc, /<head><meta http-equiv="Content-Security-Policy"/);
    assert.match(srcdoc, /<title>Demo<\/title>/);
});

test('Live Artifact preview diagnostics are normalized before display', () => {
    assert.deepEqual(
        normalizePreviewDiagnostic({
            type: 'resource-error',
            tagName: 'img',
            url: ' https://example.invalid/missing.png ',
        }),
        {
            type: 'resource-error',
            tagName: 'img',
            url: 'https://example.invalid/missing.png',
        },
    );
    assert.deepEqual(
        normalizePreviewDiagnostic({
            type: 'runtime-error',
            message: 'Boom',
            line: 12,
            column: 3,
        }),
        {
            type: 'runtime-error',
            message: 'Boom',
            line: 12,
            column: 3,
        },
    );
    assert.equal(normalizePreviewDiagnostic({ type: 'unknown' }), null);
});

test('quick Live Artifacts button toggles AMC-style active prompt state', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalFetch = globalThis.fetch;
    let savedBody = null;
    globalThis.setTimeout = (callback) => {
        if (typeof callback === 'function') callback();
        return 0;
    };
    try {
        const dom = installBrowserGlobals(`
            <!doctype html>
            <body>
                <button id="quick-live-artifacts-btn" aria-label="加载 Live Artifacts 提示并保存设置" aria-pressed="false">
                    <span>Live Artifacts</span>
                </button>
                <button id="send-btn"></button>
                <textarea id="user-input"></textarea>
                <div id="chat-container"></div>
                <section id="hero-section"></section>
            </body>
        `);
        const { state, setLiveArtifactsMode } = await import('../../backend/static/js/modules/state.js?v=5');
        const { setupChatHandler } = await import('../../backend/static/js/modules/chat.js?v=56');
        const button = document.getElementById('quick-live-artifacts-btn');

        state.settings = { search_engine: 'google', interactive_search: true };
        setLiveArtifactsMode(false);
        globalThis.fetch = async (_input, init) => {
            savedBody = JSON.parse(init.body);
            return new Response(JSON.stringify({ settings: savedBody }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        };
        setupChatHandler({
            chatContainer: document.getElementById('chat-container'),
            userInput: document.getElementById('user-input'),
            sendBtn: document.getElementById('send-btn'),
            heroSection: document.getElementById('hero-section'),
            newChatBtn: document.createElement('button'),
        }, () => {});

        assert.equal(button.textContent.trim(), 'Live Artifacts');
        assert.equal(button.getAttribute('aria-label'), '加载 Live Artifacts 提示并保存设置');
        assert.equal(button.getAttribute('aria-pressed'), 'false');

        button.click();

        assert.equal(state.liveArtifactsMode, true);
        assert.equal(button.classList.contains('active'), true);
        assert.equal(button.getAttribute('aria-pressed'), 'true');
        assert.equal(button.getAttribute('aria-label'), 'Live Artifacts 提示已激活。点击移除。');
        assert.equal(button.title, 'Live Artifacts 提示已激活。点击移除。');
        assert.equal(dom.window.document.body.textContent.includes('Canvas'), false);
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(savedBody.live_artifacts_mode, true);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.fetch = originalFetch;
    }
});

test('string false setting does not enable Live Artifacts mode', async () => {
    installBrowserGlobals();
    const { state, setLiveArtifactsMode, setSettings } = await import('../../backend/static/js/modules/state.js?v=5');

    setLiveArtifactsMode(true);
    setSettings({ live_artifacts_mode: 'false' });
    assert.equal(state.liveArtifactsMode, false);

    setSettings({ live_artifacts_mode: 'true' });
    assert.equal(state.liveArtifactsMode, true);

    setLiveArtifactsMode('false');
    assert.equal(state.liveArtifactsMode, false);
});

test('inline Live Artifacts expose cited search sources outside the iframe', () => {
    installBrowserGlobals('<!doctype html><body><div id="message"></div></body>');
    const container = document.getElementById('message');

    const artifacts = renderLiveArtifactsForMessage(
        container,
        '<section style="display:block;width:100%"><p>结论来自 [2] 和 [4]。</p></section>',
        {
            messageId: 'message-sources',
            sources: [
                { id: 1, title: 'Uncited', url: 'https://one.example' },
                { id: 2, title: 'Official report', url: 'https://two.example/report' },
                { id: 4, title: 'Unsafe source', url: 'javascript:alert(1)' },
            ],
        },
    );

    assert.equal(artifacts.length, 1);
    const strip = container.querySelector('.live-artifact-source-strip');
    const chips = Array.from(container.querySelectorAll('.live-artifact-source-chip'));

    assert.ok(strip);
    assert.equal(chips.length, 2);
    assert.equal(chips[0].getAttribute('href'), 'https://two.example/report');
    assert.equal(chips[0].getAttribute('target'), '_blank');
    assert.equal(chips[1].tagName, 'SPAN');
    assert.equal(chips[1].hasAttribute('href'), false);
    assert.equal(strip.textContent.includes('Uncited'), false);
});

test('inline Live Artifact citations inside the iframe become safe clickable source links', () => {
    installBrowserGlobals('<!doctype html><body><div id="message"></div></body>');
    const container = document.getElementById('message');

    renderLiveArtifactsForMessage(
        container,
        '<section><p>官网 [2]，危险来源 [4]。</p><code>[2]</code><a href="https://already.example">[2]</a></section>',
        {
            messageId: 'message-iframe-citations',
            sources: [
                { id: 2, title: 'Official report', url: 'https://two.example/report' },
                { id: 4, title: 'Unsafe source', url: 'javascript:alert(1)' },
            ],
        },
    );

    const frame = container.querySelector('.live-artifact-inline-iframe');
    assert.ok(frame);
    // Align with AMC ArtifactFrame sandbox (no allow-same-origin; popups for target=_blank).
    assert.equal(
        frame.getAttribute('sandbox'),
        'allow-scripts allow-forms allow-popups allow-modals allow-downloads',
    );
    assert.match(frame.srcdoc, /data-live-artifact-source-url="https:\/\/two\.example\/report"/);
    assert.match(frame.srcdoc, /window\.open\(url, '_blank'\)/);
    assert.match(frame.srcdoc, /opened\.opener = null/);
    assert.match(frame.srcdoc, /event\.preventDefault\(\);\s*openSourceUrl\(href\);/);
    assert.match(frame.srcdoc, /event: 'open-source'/);
    assert.match(frame.srcdoc, /sourceLink\.tagName === 'A'/);
    assert.doesNotMatch(frame.srcdoc, /data-live-artifact-source-url="javascript:/);
    assert.match(frame.srcdoc, /<code>\[2\]<\/code>/);
    assert.match(frame.srcdoc, /<a href="https:\/\/already\.example">\[2\]<\/a>/);
});

test('saved HTML answers with sources render citation links instead of inline artifact frames', async () => {
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div id="chat-container"></div>
            <section id="hero-section"></section>
        </body>
    `);

    const { state, setLiveArtifactsMode } = await import('../../backend/static/js/modules/state.js?v=5');
    setLiveArtifactsMode(false);
    const { elements, appendMessage } = await import('../../backend/static/js/modules/ui.js?v=43');
    Object.assign(elements, {
        chatContainer: document.getElementById('chat-container'),
        heroSection: document.getElementById('hero-section'),
    });

    appendMessage(
        'assistant',
        '<div style="display:block;width:100%"><h2>LinuxDo 是什么？</h2><p>来源给出的官网是 linux.do/。[2]</p></div>',
        null,
        [{ id: 2, title: 'Linux Do', url: 'linux.do/' }],
        null,
        1,
    );

    const body = document.querySelector('.message-answer-body');
    const citation = body.querySelector('.citation-link');
    const reference = body.querySelector('li#ref-2 a');

    assert.equal(body.querySelector('.live-artifact-inline-iframe'), null);
    assert.ok(citation);
    assert.equal(citation.textContent.trim(), '2');
    assert.equal(citation.getAttribute('href'), 'https://linux.do/');
    assert.equal(reference.getAttribute('href'), 'https://linux.do/');
});

test('saved rich HTML table answers link citation tags in place', async () => {
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div id="chat-container"></div>
            <section id="hero-section"></section>
        </body>
    `);

    const { state, setLiveArtifactsMode } = await import('../../backend/static/js/modules/state.js?v=5');
    setLiveArtifactsMode(false);
    const { elements, appendMessage } = await import('../../backend/static/js/modules/ui.js?v=43');
    Object.assign(elements, {
        chatContainer: document.getElementById('chat-container'),
        heroSection: document.getElementById('hero-section'),
    });

    appendMessage(
        'assistant',
        [
            '<div style="display:block;width:100%">',
            '<h2>LinuxDo 是什么？</h2>',
            '<table><tbody>',
            '<tr><td>官网</td><td>来源给出的官网是 linux.do/。[2]</td></tr>',
            '<tr><td>社区定位</td><td>面向技术交流、开源和分享的用户。[2][4]</td></tr>',
            '</tbody></table>',
            '</div>',
        ].join(''),
        null,
        [
            { id: 2, title: 'Linux Do', url: 'linux.do/' },
            { id: 4, title: 'Community article', url: 'https://four.example/path' },
        ],
        null,
        1,
    );

    const body = document.querySelector('.message-answer-body');
    const tableCitation = body.querySelector('table tr:first-child td:nth-child(2) .citation-link');
    const adjacentCitations = body.querySelectorAll('table tr:nth-child(2) td:nth-child(2) .citation-link');

    assert.equal(body.querySelector('.live-artifact-inline-iframe'), null);
    assert.ok(tableCitation);
    assert.equal(tableCitation.textContent.trim(), '2');
    assert.equal(tableCitation.getAttribute('href'), 'https://linux.do/');
    assert.equal(adjacentCitations.length, 2);
    assert.equal(adjacentCitations[0].getAttribute('href'), 'https://linux.do/');
    assert.equal(adjacentCitations[1].getAttribute('href'), 'https://four.example/path');
});

test('saved HTML answers with JSON-encoded sources still render citation links', async () => {
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div id="chat-container"></div>
            <section id="hero-section"></section>
        </body>
    `);

    const { state, setLiveArtifactsMode } = await import('../../backend/static/js/modules/state.js?v=5');
    setLiveArtifactsMode(false);
    const { elements, appendMessage } = await import('../../backend/static/js/modules/ui.js?v=43');
    Object.assign(elements, {
        chatContainer: document.getElementById('chat-container'),
        heroSection: document.getElementById('hero-section'),
    });

    appendMessage(
        'assistant',
        '<div style="display:block;width:100%"><p>来源给出的官网是 linux.do/。[2]</p></div>',
        ['阶段 III: 使用累计 1 个来源生成答案...'],
        JSON.stringify([{ id: 2, title: 'Linux Do', url: 'linux.do/' }]),
        null,
        1,
    );

    const body = document.querySelector('.message-answer-body');
    const citation = body.querySelector('.citation-link');
    const reference = body.querySelector('li#ref-2 a');
    const status = document.querySelector('.log-status-text');

    assert.equal(body.querySelector('.live-artifact-inline-iframe'), null);
    assert.ok(citation);
    assert.equal(citation.textContent.trim(), '2');
    assert.equal(citation.getAttribute('href'), 'https://linux.do/');
    assert.equal(reference.getAttribute('href'), 'https://linux.do/');
    assert.match(status.textContent, /1 个网页/);
});

test('Live Artifact citation linker skips unsafe urls and existing links', () => {
    installBrowserGlobals();

    const html = linkArtifactCitationsInHtml(
        '<section>来源 [2, 4] <code>[2]</code><a href="https://existing.example">[2]</a></section>',
        [
            { id: 2, title: 'Safe source', url: 'https://safe.example/path' },
            { id: 4, title: 'Unsafe source', url: 'javascript:alert(1)' },
        ],
    );
    const container = document.createElement('div');
    container.innerHTML = html;

    const citation = container.querySelector('.live-artifact-citation-link');
    assert.ok(citation);
    assert.equal(citation.textContent, '2');
    assert.equal(citation.getAttribute('href'), 'https://safe.example/path');
    assert.equal(citation.getAttribute('target'), '_blank');
    assert.equal(citation.getAttribute('data-live-artifact-source-url'), 'https://safe.example/path');
    assert.equal(container.textContent.includes('[4]'), true);
    assert.equal(container.querySelector('code').textContent, '[2]');
    assert.equal(container.querySelector('a[href="https://existing.example"]').textContent, '[2]');
    assert.equal(container.innerHTML.includes('javascript:alert'), false);
});

test('Live Artifact citation linker normalizes bare-domain source urls', () => {
    installBrowserGlobals();

    const html = linkArtifactCitationsInHtml('<section>官网 [2]</section>', [
        { id: 2, title: 'Linux Do', url: 'linux.do/' },
    ]);
    const container = document.createElement('div');
    container.innerHTML = html;

    const citation = container.querySelector('.live-artifact-citation-link');
    assert.ok(citation);
    assert.equal(citation.getAttribute('href'), 'https://linux.do/');
    assert.equal(citation.getAttribute('data-live-artifact-source-url'), 'https://linux.do/');
    assert.equal(citation.getAttribute('target'), '_blank');
});

test('inline Live Artifacts accept JSON-encoded cited source arrays', () => {
    installBrowserGlobals('<!doctype html><body><div id="message"></div></body>');
    const container = document.getElementById('message');

    renderLiveArtifactsForMessage(
        container,
        '<section><p>官网 [1]</p></section>',
        {
            messageId: 'message-json-sources',
            sources: JSON.stringify(['linux.do/']),
        },
    );

    const chip = container.querySelector('.live-artifact-source-chip');
    const frame = container.querySelector('.live-artifact-inline-iframe');

    assert.ok(chip);
    assert.equal(chip.getAttribute('href'), 'https://linux.do/');
    assert.match(frame.srcdoc, /data-live-artifact-source-url="https:\/\/linux\.do\/"/);
});

test('Live Artifact frame messages require a registered preview iframe source', () => {
    installBrowserGlobals('<!doctype html><body><div id="message"></div><textarea id="user-input"></textarea></body>');
    const container = document.getElementById('message');
    const opened = [];
    const originalOpen = window.open;
    window.open = (...args) => {
        opened.push(args);
        return { opener: window };
    };

    try {
        renderLiveArtifactsForMessage(
            container,
            '<section><p>可信预览</p></section>',
            { messageId: 'trusted-frame-message' },
        );
        const frame = container.querySelector('.live-artifact-inline-iframe');
        assert.ok(frame);

        handleArtifactFrameMessage({
            source: window,
            data: {
                channel: 'justsearch-live-artifacts',
                event: 'open-source',
                url: 'trusted.example/source',
            },
        });
        assert.equal(opened.length, 0);

        handleArtifactFrameMessage({
            source: frame.contentWindow,
            data: {
                channel: 'justsearch-live-artifacts',
                event: 'open-source',
                url: 'trusted.example/source',
            },
        });
        assert.equal(opened.length, 1);
        assert.equal(opened[0][0], 'https://trusted.example/source');

        const input = document.getElementById('user-input');
        handleArtifactFrameMessage({
            source: window,
            data: {
                channel: 'justsearch-live-artifacts',
                event: 'followup',
                payload: { instruction: '伪造请求', state: { selected: 'A' } },
            },
        });
        assert.equal(input.value, '');

        handleArtifactFrameMessage({
            source: frame.contentWindow,
            data: {
                channel: 'justsearch-live-artifacts',
                event: 'followup',
                payload: { instruction: '可信请求', state: { selected: 'B' } },
            },
        });
        assert.match(input.value, /可信请求/);
        assert.match(input.value, /"selected": "B"/);
    } finally {
        window.open = originalOpen;
    }
});

test('streamChat sends live_artifacts_mode without the old Canvas request field', async () => {
    installBrowserGlobals();
    const { state } = await import('../../backend/static/js/modules/state.js?v=5');
    const { streamChat } = await import('../../backend/static/js/modules/api.js?v=14');
    let capturedBody = null;
    let doneCalled = false;

    state.currentSessionId = 'session-live-artifacts';
    state.settings = {
        default_provider_id: 'provider-a',
        search_engine: 'google',
        max_results: 10,
        max_iterations: 3,
        interactive_search: true,
        max_concurrent_pages: 4,
    };
    globalThis.fetch = async (_input, init) => {
        capturedBody = JSON.parse(init.body);
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
            },
        }), { status: 200 });
    };

    await streamChat('生成一个可交互图表', {
        model: 'model-a',
        providerId: 'provider-a',
        liveArtifactsMode: true,
        onDone: () => { doneCalled = true; },
    });

    assert.equal(doneCalled, true);
    assert.equal(capturedBody.live_artifacts_mode, true);
    assert.equal(capturedBody.max_concurrent_pages, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(capturedBody, 'canvas_mode'), false);
});

test('streamChat processes trailing SSE event when stream closes without blank delimiter', async () => {
    installBrowserGlobals();
    const { state } = await import('../../backend/static/js/modules/state.js?v=5');
    const { streamChat } = await import('../../backend/static/js/modules/api.js?v=14');
    let answer = null;
    let doneCalled = false;

    state.currentSessionId = 'session-trailing-sse';
    state.settings = {
        default_provider_id: 'provider-a',
        search_engine: 'google',
        max_results: 10,
        max_iterations: 3,
        interactive_search: true,
    };
    globalThis.fetch = async () => {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(
                    'data: {"type":"answer","content":"final answer","session_id":"session-trailing-sse","sources":[{"id":2,"title":"Linux Do","url":"linux.do/"}]}',
                ));
                controller.close();
            },
        }), { status: 200 });
    };

    await streamChat('hello', {
        model: 'model-a',
        providerId: 'provider-a',
        onAnswer: (content, sessionId, sources) => { answer = { content, sessionId, sources }; },
        onDone: () => { doneCalled = true; },
    });

    assert.deepEqual(answer, {
        content: 'final answer',
        sessionId: 'session-trailing-sse',
        sources: [{ id: 2, title: 'Linux Do', url: 'linux.do/' }],
    });
    assert.equal(doneCalled, true);
});

test('streamChat treats SSE error events as terminal failures', async () => {
    installBrowserGlobals();
    const { state } = await import('../../backend/static/js/modules/state.js?v=5');
    const { streamChat } = await import('../../backend/static/js/modules/api.js?v=14');
    const encoder = new TextEncoder();
    let errorMessage = '';
    let doneCalled = false;
    const chunks = [];

    state.currentSessionId = 'session-sse-error';
    state.settings = {
        default_provider_id: 'provider-a',
        search_engine: 'google',
        max_results: 10,
        max_iterations: 3,
        interactive_search: true,
    };
    globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode([
                'data: {"type":"answer_chunk","content":"partial"}',
                '',
                'data: {"type":"error","content":"model failed"}',
                '',
                'data: {"type":"answer_chunk","content":"late"}',
                '',
            ].join('\n')));
            controller.close();
        },
    }), { status: 200 });

    await streamChat('hello', {
        model: 'model-a',
        providerId: 'provider-a',
        onAnswerChunk: chunk => chunks.push(chunk),
        onError: message => { errorMessage = message; },
        onDone: () => { doneCalled = true; },
    });

    assert.deepEqual(chunks, ['partial']);
    assert.equal(errorMessage, 'model failed');
    assert.equal(doneCalled, false);
});

test('streamChat reports plain text error responses from gateways', async () => {
    installBrowserGlobals();
    const { state } = await import('../../backend/static/js/modules/state.js?v=5');
    const { streamChat } = await import('../../backend/static/js/modules/api.js?v=14');
    let errorMessage = '';

    state.currentSessionId = 'session-text-error';
    state.settings = {
        default_provider_id: 'provider-a',
        search_engine: 'google',
        max_results: 10,
        max_iterations: 3,
        interactive_search: true,
    };
    globalThis.fetch = async () => new Response('gateway unavailable', { status: 502 });

    await streamChat('hello', {
        model: 'model-a',
        providerId: 'provider-a',
        onError: message => { errorMessage = message; },
    });

    assert.equal(errorMessage, 'gateway unavailable');
});

test('streamChat does not retry a non-idempotent chat request after response starts', async () => {
    installBrowserGlobals();
    const { state } = await import('../../backend/static/js/modules/state.js?v=5');
    const { streamChat } = await import('../../backend/static/js/modules/api.js?v=14');
    const originalSetTimeout = globalThis.setTimeout;
    const originalConsoleError = console.error;
    let fetchCalls = 0;
    const chunks = [];

    state.currentSessionId = 'session-midstream-error';
    state.settings = {
        default_provider_id: 'provider-a',
        search_engine: 'google',
        max_results: 10,
        max_iterations: 3,
        interactive_search: true,
    };

    globalThis.setTimeout = (callback) => {
        if (typeof callback === 'function') callback();
        return 0;
    };
    console.error = () => {};
    try {
        globalThis.fetch = async () => {
            fetchCalls += 1;
            const encoder = new TextEncoder();
            let sent = false;
            return new Response(new ReadableStream({
                pull(controller) {
                    if (!sent) {
                        sent = true;
                        controller.enqueue(encoder.encode(
                            'data: {"type":"answer_chunk","content":"partial"}\n\n',
                        ));
                        return;
                    }
                    controller.error(new Error('socket closed'));
                },
            }), { status: 200 });
        };

        await assert.rejects(
            streamChat('hello', {
                model: 'model-a',
                providerId: 'provider-a',
                onAnswerChunk: chunk => chunks.push(chunk),
            }),
            /socket closed/,
        );

        assert.equal(fetchCalls, 1);
        assert.deepEqual(chunks, ['partial']);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        console.error = originalConsoleError;
    }
});

test('streaming inline HTML uses a stable stream shell; markup stays on streamHtml', () => {
    const html = '<section style="display:grid"><strong>Partial';
    const artifact = extractInlineLiveArtifact(html, 'message-stream', true);

    assert.ok(artifact);
    assert.equal(artifact.isStreaming, true);
    assert.equal(artifact.streamHtml, html);
    // Stable shell prevents per-chunk iframe reloads; bridge still handles stream-render.
    assert.match(artifact.srcdoc, /data-amc-stream-preview-root="true"/);
    assert.match(artifact.srcdoc, /stream-render/);
    assert.match(artifact.srcdoc, /sanitizeStreamDocument/);
    assert.match(artifact.srcdoc, /event: 'ready'/);
    assert.doesNotMatch(artifact.srcdoc, /Partial/);
});

test('streaming preview reuses srcdoc across chunks and pushes stream-render updates', () => {
    installBrowserGlobals('<!doctype html><body><div id="message"></div></body>');
    const container = document.getElementById('message');
    const partial = '<section style="display:block;width:100%"><h2>Live';
    const fuller = '<section style="display:block;width:100%"><h2>Live Title</h2><p>Body text</p></section>';
    const posts = [];

    renderLiveArtifactsForMessage(container, partial, {
        messageId: 'stream-stable',
        isStreaming: true,
    });
    const frame1 = container.querySelector('.live-artifact-inline-iframe');
    assert.ok(frame1);
    const srcdoc1 = frame1.getAttribute('srcdoc') || frame1.srcdoc || '';
    assert.match(srcdoc1, /data-amc-stream-preview-root="true"/);
    assert.doesNotMatch(srcdoc1, /Live Title/);
    assert.match(frame1.dataset.liveArtifactPendingStreamHtml || '', /Live/);

    Object.defineProperty(frame1, 'contentWindow', {
        value: {
            postMessage(data) {
                posts.push(data);
            },
        },
        configurable: true,
    });

    renderLiveArtifactsForMessage(container, fuller, {
        messageId: 'stream-stable',
        isStreaming: true,
    });
    const frame2 = container.querySelector('.live-artifact-inline-iframe');
    assert.equal(frame1, frame2, 'iframe element is reused across stream updates');
    const srcdoc2 = frame2.getAttribute('srcdoc') || frame2.srcdoc || '';
    assert.equal(srcdoc2, srcdoc1, 'srcdoc must stay stable while streaming (no iframe reload)');
    assert.match(frame2.dataset.liveArtifactPendingStreamHtml || '', /Live Title/);
    assert.match(frame2.dataset.liveArtifactPendingStreamHtml || '', /Body text/);
    assert.ok(
        posts.some((msg) => (
            msg
            && msg.channel === 'justsearch-live-artifacts'
            && msg.event === 'stream-render'
            && /Live Title/.test(msg.html || '')
        )),
        'stream-render postMessage should carry updated markup',
    );

    renderLiveArtifactsForMessage(container, fuller, {
        messageId: 'stream-stable',
        isStreaming: false,
    });
    // Stream → final transitions remount the iframe (fresh node) so the final
    // srcdoc reliably navigates — re-query the current frame instead of the
    // stale pre-final reference.
    const frameFinal = container.querySelector('.live-artifact-inline-iframe');
    assert.match(frameFinal.getAttribute('srcdoc') || frameFinal.srcdoc || '', /Body text/);
    assert.equal(frameFinal.dataset.liveArtifactStreaming, 'false');
});

test('public inline Live Artifact probe matches AMC raw HTML fragments', () => {
    const artifact = getInlineLiveArtifact(
        '<div style="display:block;width:100%">Ready</div>',
        'message-public',
        false,
    );

    assert.ok(artifact);
    assert.equal(artifact.key, 'message-public:inline-0');
});

test('AMC Live Artifact interaction JSON is parsed into a schema form spec', () => {
    const spec = parseLiveArtifactInteractionSpec(JSON.stringify({
        version: 1,
        title: '论文写作参数',
        instruction: '根据这些论文参数继续写作。',
        submitLabel: '开始写作',
        schema: {
            type: 'object',
            required: ['topic'],
            properties: {
                topic: { type: 'string', title: '论文主题' },
                style: { type: 'string', enum: ['APA', 'MLA'], default: 'APA' },
                outline: { type: 'boolean', default: true },
                words: { type: 'integer', default: 2000, minimum: 100, maximum: 5000 },
            },
        },
    }));

    assert.ok(spec);
    assert.equal(spec.title, '论文写作参数');
    assert.equal(spec.schema.properties.topic.type, 'string');
    assert.deepEqual(spec.schema.required, ['topic']);
});

test('AMC Live Artifact interaction fence is detected while streaming', () => {
    const interaction = extractLiveArtifactInteraction(
        '```amc-live-artifact-interaction\n{"instruction":"Collect","schema":{',
        true,
    );

    assert.deepEqual(interaction, { pending: true });
});

test('legacy HTML fragments still merge same-message CSS and JavaScript support blocks', () => {
    const markdown = [
        '```css',
        '.stage { color: blue; }',
        '```',
        '```html title="Fragment Demo"',
        '<section class="stage"><button id="go">Go</button></section>',
        '```',
        '```javascript',
        'document.getElementById("go").textContent = "Done";',
        '```',
    ].join('\n');

    const artifacts = extractLiveArtifacts(markdown, 'message-b');

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].title, 'Fragment Demo');
    assert.deepEqual(artifacts[0].supportBlockIndices, [0, 2]);
    assert.match(artifacts[0].code, /<style>[\s\S]*\.stage/);
    assert.match(artifacts[0].code, /<script>[\s\S]*getElementById/);
});

test('explicit artifact metadata can declare HTML renderability', () => {
    const markdown = [
        '```artifact type="text/html" title="Metric Card" filename="metric-card.html"',
        '<section><h1>Metric</h1></section>',
        '```',
    ].join('\n');

    const artifacts = extractLiveArtifacts(markdown, 'message-c');

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].title, 'Metric Card');
    assert.equal(artifacts[0].fileName, 'metric-card.html');
    assert.equal(artifacts[0].renderable, true);
    assert.match(artifacts[0].srcdoc, /<section><h1>Metric<\/h1><\/section>/);
});

test('streaming chat re-renders citations when sources arrive after answer chunks', async () => {
    const originalFetch = globalThis.fetch;
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <select id="model-select">
                <option value="model-a" data-provider-id="provider-a">Model A</option>
            </select>
            <button id="send-btn"><span class="material-symbols-rounded">send</span></button>
            <textarea id="user-input"></textarea>
            <div id="chat-container"></div>
            <section id="hero-section"></section>
            <button id="new-chat-btn"></button>
        </body>
    `);

    try {
        const { state, setCurrentSessionId, setLiveArtifactsMode } = await import('../../backend/static/js/modules/state.js?v=5');
        const { elements } = await import('../../backend/static/js/modules/ui.js?v=43');
        const { setupChatHandler } = await import('../../backend/static/js/modules/chat.js?v=56');
        const encoder = new TextEncoder();
        const events = [
            { type: 'meta', session_id: 'late-sources-session' },
            { type: 'answer_chunk', content: '官网 [2]' },
            { type: 'sources', content: [{ id: 2, title: 'Linux Do', url: 'linux.do/' }] },
            { type: 'answer', content: '官网 [2]', session_id: 'late-sources-session' },
        ]
            .map(event => `data: ${JSON.stringify(event)}\n\n`)
            .join('') + 'data: [DONE]\n\n';

        setCurrentSessionId(null);
        setLiveArtifactsMode(false);
        state.settings = {
            default_provider_id: 'provider-a',
            search_engine: 'google',
            max_results: 10,
            max_iterations: 3,
            interactive_search: true,
            max_concurrent_pages: 4,
        };

        globalThis.fetch = async (input) => {
            const url = String(input);
            if (url === '/api/chat') {
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode(events));
                        controller.close();
                    },
                }), { status: 200 });
            }
            if (url === '/api/health') {
                return new Response(JSON.stringify({ bridge: { extension_connected: true } }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url === '/api/history' || url === '/api/history/groups') {
                return new Response(JSON.stringify([]), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected request: ${url}`);
        };

        const testElements = {
            chatContainer: document.getElementById('chat-container'),
            userInput: document.getElementById('user-input'),
            sendBtn: document.getElementById('send-btn'),
            heroSection: document.getElementById('hero-section'),
            newChatBtn: document.getElementById('new-chat-btn'),
        };
        Object.assign(elements, testElements);
        setupChatHandler(testElements, () => {});

        const input = document.getElementById('user-input');
        input.value = 'linuxdo是什么';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send-btn').click();

        for (let i = 0; i < 20; i += 1) {
            const citation = document.querySelector('.message-answer-body .citation-link');
            if (citation) break;
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        const citation = document.querySelector('.message-answer-body .citation-link');
        const reference = document.querySelector('.message-answer-body li#ref-2 a');
        assert.ok(citation);
        assert.equal(citation.textContent.trim(), '2');
        assert.equal(citation.getAttribute('href'), 'https://linux.do/');
        assert.equal(reference.getAttribute('href'), 'https://linux.do/');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('streaming chat marks SSE error events as failed instead of completed', async () => {
    const originalFetch = globalThis.fetch;
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <select id="model-select">
                <option value="model-a" data-provider-id="provider-a">Model A</option>
            </select>
            <button id="send-btn"><span class="material-symbols-rounded">send</span></button>
            <textarea id="user-input"></textarea>
            <div id="chat-container"></div>
            <section id="hero-section"></section>
            <button id="new-chat-btn"></button>
        </body>
    `);

    try {
        const { state, setCurrentSessionId, setLiveArtifactsMode } = await import('../../backend/static/js/modules/state.js?v=5');
        const { elements } = await import('../../backend/static/js/modules/ui.js?v=43');
        const { setupChatHandler } = await import('../../backend/static/js/modules/chat.js?v=56');
        const encoder = new TextEncoder();
        const events = [
            { type: 'meta', session_id: 'error-status-session' },
            { type: 'log', content: '正在调用 AI 模型生成回答...' },
            { type: 'error', content: 'model failed' },
        ]
            .map(event => `data: ${JSON.stringify(event)}\n\n`)
            .join('');

        setCurrentSessionId(null);
        setLiveArtifactsMode(false);
        state.settings = {
            default_provider_id: 'provider-a',
            search_engine: 'google',
            max_results: 10,
            max_iterations: 3,
            interactive_search: true,
            max_concurrent_pages: 4,
        };

        globalThis.fetch = async (input) => {
            const url = String(input);
            if (url === '/api/chat') {
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode(events));
                        controller.close();
                    },
                }), { status: 200 });
            }
            if (url === '/api/health') {
                return new Response(JSON.stringify({ bridge: { extension_connected: true } }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected request: ${url}`);
        };

        const testElements = {
            chatContainer: document.getElementById('chat-container'),
            userInput: document.getElementById('user-input'),
            sendBtn: document.getElementById('send-btn'),
            heroSection: document.getElementById('hero-section'),
            newChatBtn: document.getElementById('new-chat-btn'),
        };
        Object.assign(elements, testElements);
        setupChatHandler(testElements, () => {});

        const input = document.getElementById('user-input');
        input.value = '触发错误';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send-btn').click();

        for (let i = 0; i < 20; i += 1) {
            const status = document.querySelector('.log-status-text');
            if (status?.textContent.startsWith('失败')) break;
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        const errorBox = document.querySelector('.message-answer-body .error-box');
        const status = document.querySelector('.log-status-text');
        const spinner = document.querySelector('.log-spinner');
        const logContainer = document.querySelector('.log-container');

        assert.match(errorBox.textContent, /model failed/);
        assert.match(status.textContent, /^失败 · /);
        assert.equal(spinner.textContent, 'error');
        assert.equal(spinner.classList.contains('failed'), true);
        assert.equal(logContainer.classList.contains('failed'), true);
        assert.equal(logContainer.classList.contains('completed'), false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('final baked srcdoc is not overwritten by a delayed streaming render (race guard)', async () => {
    // P0-4: when answer_chunk and answer arrive in the same macrotask (rAF not
    // yet flushed), the scheduled streaming render's rAF fires AFTER onAnswer
    // baked the final srcdoc. The race guard (streamRenderSeq) must skip that
    // stale streaming render so the baked content survives.
    const originalFetch = globalThis.fetch;
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <select id="model-select">
                <option value="model-a" data-provider-id="provider-a">Model A</option>
            </select>
            <button id="send-btn"><span class="material-symbols-rounded">send</span></button>
            <textarea id="user-input"></textarea>
            <div id="chat-container"></div>
            <section id="hero-section"></section>
            <button id="new-chat-btn"></button>
        </body>
    `);

    try {
        const { state, setCurrentSessionId, setLiveArtifactsMode } = await import('../../backend/static/js/modules/state.js?v=5');
        const { elements } = await import('../../backend/static/js/modules/ui.js?v=43');
        const { setupChatHandler } = await import('../../backend/static/js/modules/chat.js?v=56');
        const encoder = new TextEncoder();
        // chunk and final answer in the same macrotask so rAF is still pending.
        const finalHtml = '<div style="display:block;width:100%"><h2>Final</h2><p>done</p></div>';
        const events = [
            { type: 'meta', session_id: 'race-guard-session' },
            { type: 'answer_chunk', content: finalHtml },
            { type: 'answer', content: finalHtml, session_id: 'race-guard-session' },
        ]
            .map(event => `data: ${JSON.stringify(event)}\n\n`)
            .join('') + 'data: [DONE]\n\n';

        setCurrentSessionId(null);
        setLiveArtifactsMode(true);
        state.settings = {
            default_provider_id: 'provider-a',
            search_engine: 'google',
            max_results: 10,
            max_iterations: 3,
            interactive_search: true,
            max_concurrent_pages: 4,
            live_artifacts_mode: true,
        };

        globalThis.fetch = async (input) => {
            const url = String(input);
            if (url === '/api/chat') {
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode(events));
                        controller.close();
                    },
                }), { status: 200 });
            }
            if (url === '/api/health') {
                return new Response(JSON.stringify({ bridge: { extension_connected: true } }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url === '/api/history' || url === '/api/history/groups') {
                return new Response(JSON.stringify([]), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected request: ${url}`);
        };

        const testElements = {
            chatContainer: document.getElementById('chat-container'),
            userInput: document.getElementById('user-input'),
            sendBtn: document.getElementById('send-btn'),
            heroSection: document.getElementById('hero-section'),
            newChatBtn: document.getElementById('new-chat-btn'),
        };
        Object.assign(elements, testElements);
        setupChatHandler(testElements, () => {});

        const input = document.getElementById('user-input');
        input.value = 'race guard test';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send-btn').click();

        // Let the queued rAF fire (it would normally overwrite the bake).
        for (let i = 0; i < 20; i += 1) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        const frame = document.querySelector('.message-answer-body .live-artifact-inline-iframe');
        assert.ok(frame, 'inline artifact frame should exist after bake');
        const srcdoc = frame.getAttribute('srcdoc') || '';
        // Final baked content must survive the stale streaming rAF.
        assert.ok(/<h2>Final<\/h2>/.test(srcdoc), `baked srcdoc should retain final content; got: ${srcdoc.slice(0, 200)}`);
        // The streaming shell element must NOT be present in the body — that
        // would mean the stale streaming render overwrote the bake. (Note: the
        // base styles always contain the CSS selector `body > [data-amc-stream-preview-root]`,
        // so we match the actual streaming-root element, not the selector.)
        assert.ok(!/<div data-amc-stream-preview-root="true"/.test(srcdoc), 'stale streaming render overwrote baked srcdoc');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('streaming raw HTML answer exits inline artifact mode when sources arrive', async () => {
    const originalFetch = globalThis.fetch;
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <select id="model-select">
                <option value="model-a" data-provider-id="provider-a">Model A</option>
            </select>
            <button id="send-btn"><span class="material-symbols-rounded">send</span></button>
            <textarea id="user-input"></textarea>
            <div id="chat-container"></div>
            <section id="hero-section"></section>
            <button id="new-chat-btn"></button>
        </body>
    `);

    try {
        const { state, setCurrentSessionId, setLiveArtifactsMode } = await import('../../backend/static/js/modules/state.js?v=5');
        const { elements } = await import('../../backend/static/js/modules/ui.js?v=43');
        const { setupChatHandler } = await import('../../backend/static/js/modules/chat.js?v=56');
        const encoder = new TextEncoder();
        const htmlAnswer = '<div style="display:block;width:100%"><h2>LinuxDo 是什么？</h2><p>来源给出的官网是 linux.do/。[2]</p></div>';
        const events = [
            { type: 'meta', session_id: 'late-html-sources-session' },
            { type: 'answer_chunk', content: htmlAnswer },
            { type: 'sources', content: [{ id: 2, title: 'Linux Do', url: 'linux.do/' }] },
            { type: 'answer', content: htmlAnswer, session_id: 'late-html-sources-session' },
        ]
            .map(event => `data: ${JSON.stringify(event)}\n\n`)
            .join('') + 'data: [DONE]\n\n';

        setCurrentSessionId(null);
        setLiveArtifactsMode(false);
        state.settings = {
            default_provider_id: 'provider-a',
            search_engine: 'google',
            max_results: 10,
            max_iterations: 3,
            interactive_search: true,
            max_concurrent_pages: 4,
        };

        globalThis.fetch = async (input) => {
            const url = String(input);
            if (url === '/api/chat') {
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode(events));
                        controller.close();
                    },
                }), { status: 200 });
            }
            if (url === '/api/health') {
                return new Response(JSON.stringify({ bridge: { extension_connected: true } }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url === '/api/history' || url === '/api/history/groups') {
                return new Response(JSON.stringify([]), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected request: ${url}`);
        };

        const testElements = {
            chatContainer: document.getElementById('chat-container'),
            userInput: document.getElementById('user-input'),
            sendBtn: document.getElementById('send-btn'),
            heroSection: document.getElementById('hero-section'),
            newChatBtn: document.getElementById('new-chat-btn'),
        };
        Object.assign(elements, testElements);
        setupChatHandler(testElements, () => {});

        const input = document.getElementById('user-input');
        input.value = 'linuxdo是什么';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send-btn').click();

        for (let i = 0; i < 20; i += 1) {
            const citation = document.querySelector('.message-answer-body .citation-link');
            if (citation) break;
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        const body = document.querySelector('.message-answer-body');
        const citation = body.querySelector('.citation-link');
        const reference = body.querySelector('li#ref-2 a');
        assert.equal(body.querySelector('.live-artifact-inline-iframe'), null);
        assert.ok(citation);
        assert.equal(citation.textContent.trim(), '2');
        assert.equal(citation.getAttribute('href'), 'https://linux.do/');
        assert.equal(reference.getAttribute('href'), 'https://linux.do/');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('streaming raw HTML answer links citations from final answer sources', async () => {
    const originalFetch = globalThis.fetch;
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <select id="model-select">
                <option value="model-a" data-provider-id="provider-a">Model A</option>
            </select>
            <button id="send-btn"><span class="material-symbols-rounded">send</span></button>
            <textarea id="user-input"></textarea>
            <div id="chat-container"></div>
            <section id="hero-section"></section>
            <button id="new-chat-btn"></button>
        </body>
    `);

    try {
        const { state, setCurrentSessionId, setLiveArtifactsMode } = await import('../../backend/static/js/modules/state.js?v=5');
        const { elements } = await import('../../backend/static/js/modules/ui.js?v=43');
        const { setupChatHandler } = await import('../../backend/static/js/modules/chat.js?v=56');
        const encoder = new TextEncoder();
        const htmlAnswer = '<div style="display:block;width:100%"><h2>LinuxDo 是什么？</h2><p>来源给出的官网是 linux.do/。[2]</p></div>';
        const events = [
            { type: 'meta', session_id: 'final-html-sources-session' },
            { type: 'answer_chunk', content: htmlAnswer },
            {
                type: 'answer',
                content: htmlAnswer,
                session_id: 'final-html-sources-session',
                sources: [{ id: 2, title: 'Linux Do', url: 'linux.do/' }],
            },
        ]
            .map(event => `data: ${JSON.stringify(event)}\n\n`)
            .join('') + 'data: [DONE]\n\n';

        setCurrentSessionId(null);
        setLiveArtifactsMode(false);
        state.settings = {
            default_provider_id: 'provider-a',
            search_engine: 'google',
            max_results: 10,
            max_iterations: 3,
            interactive_search: true,
            max_concurrent_pages: 4,
        };

        globalThis.fetch = async (input) => {
            const url = String(input);
            if (url === '/api/chat') {
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode(events));
                        controller.close();
                    },
                }), { status: 200 });
            }
            if (url === '/api/health') {
                return new Response(JSON.stringify({ bridge: { extension_connected: true } }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url === '/api/history' || url === '/api/history/groups') {
                return new Response(JSON.stringify([]), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected request: ${url}`);
        };

        const testElements = {
            chatContainer: document.getElementById('chat-container'),
            userInput: document.getElementById('user-input'),
            sendBtn: document.getElementById('send-btn'),
            heroSection: document.getElementById('hero-section'),
            newChatBtn: document.getElementById('new-chat-btn'),
        };
        Object.assign(elements, testElements);
        setupChatHandler(testElements, () => {});

        const input = document.getElementById('user-input');
        input.value = 'linuxdo是什么';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('send-btn').click();

        for (let i = 0; i < 20; i += 1) {
            const citation = document.querySelector('.message-answer-body .citation-link');
            if (citation) break;
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        const body = document.querySelector('.message-answer-body');
        const citation = body.querySelector('.citation-link');
        const reference = body.querySelector('li#ref-2 a');
        assert.equal(body.querySelector('.live-artifact-inline-iframe'), null);
        assert.ok(citation);
        assert.equal(citation.textContent.trim(), '2');
        assert.equal(citation.getAttribute('href'), 'https://linux.do/');
        assert.equal(reference.getAttribute('href'), 'https://linux.do/');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('citation rendering resolves sparse source ids instead of array positions', async () => {
    installBrowserGlobals();
    const { renderWithCitations } = await import('../../backend/static/js/modules/source-renderer.js?v=12');

    const html = renderWithCitations('Sparse citation [4]', [
        { id: 2, title: 'Second', url: 'https://two.example' },
        { id: 4, title: 'Fourth', url: 'https://four.example' },
    ]);
    const container = document.createElement('div');
    container.innerHTML = html;

    const citation = container.querySelector('.citation-link');
    assert.ok(citation);
    assert.equal(citation.textContent.trim(), '4');
    assert.equal(citation.getAttribute('href'), 'https://four.example');
    assert.equal(container.querySelector('li#ref-4 a').textContent, 'Fourth');
});

test('citation rendering normalizes bare-domain source urls', async () => {
    installBrowserGlobals();
    const { hasCitationSources, renderWithCitations } = await import('../../backend/static/js/modules/source-renderer.js?v=12');

    const html = renderWithCitations('官网 [2]', [
        { id: 2, title: 'Linux Do', url: 'linux.do/' },
    ]);
    const container = document.createElement('div');
    container.innerHTML = html;

    const citation = container.querySelector('.citation-link');
    const reference = container.querySelector('li#ref-2 a');

    assert.ok(citation);
    assert.equal(citation.textContent.trim(), '2');
    assert.equal(citation.getAttribute('href'), 'https://linux.do/');
    assert.equal(citation.getAttribute('target'), '_blank');
    assert.equal(reference.getAttribute('href'), 'https://linux.do/');
    assert.equal(reference.getAttribute('target'), '_blank');
    assert.equal(hasCitationSources(JSON.stringify([{ id: 2, title: 'Linux Do', url: 'linux.do/' }])), true);
});

test('citation hydration links raw citation tags left in rendered HTML', async () => {
    installBrowserGlobals();
    const { linkCitationsInElement } = await import('../../backend/static/js/modules/source-renderer.js?v=12');

    const container = document.createElement('div');
    container.innerHTML = [
        '<table><tbody><tr><td>官网</td><td>来源给出的官网是 linux.do/。[2]</td></tr></tbody></table>',
        '<a href="https://already.example">[2]</a>',
        '<code>[2]</code>',
    ].join('');

    const linked = linkCitationsInElement(container, [
        { id: 2, title: 'Linux Do', url: 'linux.do/' },
    ]);
    const citation = container.querySelector('table .citation-link');

    assert.equal(linked, true);
    assert.ok(citation);
    assert.equal(citation.textContent.trim(), '2');
    assert.equal(citation.getAttribute('href'), 'https://linux.do/');
    assert.equal(container.querySelector('a[href="https://already.example"]').textContent, '[2]');
    assert.equal(container.querySelector('code').textContent, '[2]');
});

test('citation rendering accepts JSON-encoded source arrays', async () => {
    installBrowserGlobals();
    const { hasCitationSources, renderWithCitations } = await import('../../backend/static/js/modules/source-renderer.js?v=12');

    const html = renderWithCitations(
        '<div><p>官网来源 [2]</p><code>[2]</code></div>',
        JSON.stringify([{ id: 2, title: 'Linux Do', url: 'linux.do/' }]),
    );
    const container = document.createElement('div');
    container.innerHTML = html;

    const citation = container.querySelector('.citation-link');
    const reference = container.querySelector('li#ref-2 a');

    assert.equal(hasCitationSources('not json'), false);
    assert.ok(citation);
    assert.equal(citation.textContent.trim(), '2');
    assert.equal(citation.getAttribute('href'), 'https://linux.do/');
    assert.equal(container.querySelector('code').textContent, '[2]');
    assert.equal(reference.getAttribute('href'), 'https://linux.do/');
});

test('citation rendering links citations from embedded reference markdown when sources are absent', async () => {
    installBrowserGlobals();
    const { renderWithCitations } = await import('../../backend/static/js/modules/source-renderer.js?v=12');

    const html = renderWithCitations([
        '官网 来源给出的官网是 linux.do/。[2]',
        '',
        '---',
        '### 参考资料',
        '[2] [Linux Do](linux.do/)  ',
    ].join('\n'), []);
    const container = document.createElement('div');
    container.innerHTML = html;

    const citation = container.querySelector('.citation-link');
    const reference = container.querySelector('li#ref-2 a');

    assert.ok(citation);
    assert.equal(citation.textContent.trim(), '2');
    assert.equal(citation.getAttribute('href'), 'https://linux.do/');
    assert.equal(citation.getAttribute('target'), '_blank');
    assert.equal(reference.getAttribute('href'), 'https://linux.do/');
    assert.equal(reference.textContent, 'Linux Do');
});

test('citation rendering neutralizes non-http source urls', async () => {
    installBrowserGlobals();
    const { renderWithCitations } = await import('../../backend/static/js/modules/source-renderer.js?v=12');

    const html = renderWithCitations('Unsafe citation [1]', [
        { id: 1, title: 'Unsafe', url: 'javascript:alert(1)' },
    ]);
    const container = document.createElement('div');
    container.innerHTML = html;

    const citation = container.querySelector('.citation-link');
    const reference = container.querySelector('li#ref-1 a');

    assert.equal(citation.getAttribute('href'), '#');
    assert.equal(citation.hasAttribute('target'), false);
    assert.equal(reference.getAttribute('href'), '#');
    assert.equal(reference.hasAttribute('target'), false);
    assert.equal(container.querySelector('.citation-favicon'), null);
});

test('citation rendering tolerates malformed source payloads', async () => {
    installBrowserGlobals();
    const { renderWithCitations } = await import('../../backend/static/js/modules/source-renderer.js?v=12');

    assert.doesNotThrow(() => renderWithCitations('No sources [1]', { id: 1, url: 'https://bad.example' }));
    assert.doesNotThrow(() => renderWithCitations(null, [{ id: 1, url: 'https://safe.example' }]));

    const html = renderWithCitations('Mixed sources [2] [4] [5]', [
        null,
        'valid.example/path',
        42,
        { id: 4, title: 123, url: 'https://four.example' },
        { id: 5, title: '', url: '' },
    ]);
    const container = document.createElement('div');
    container.innerHTML = html;

    const citations = Array.from(container.querySelectorAll('.citation-link'));
    assert.equal(citations.length, 3);
    assert.equal(citations[0].textContent.trim(), '2');
    assert.equal(citations[0].getAttribute('href'), 'https://valid.example/path');
    assert.equal(citations[1].textContent.trim(), '4');
    assert.equal(citations[1].getAttribute('href'), 'https://four.example');
    assert.equal(citations[2].textContent.trim(), '5');
    assert.equal(citations[2].getAttribute('href'), '#');
    assert.equal(citations[2].hasAttribute('target'), false);
});

test('rebuildLiveArtifactFrames re-navigates srcdoc iframes after background discard', () => {
    installBrowserGlobals('<!doctype html><body><div id="message"></div></body>');
    const container = document.getElementById('message');

    renderLiveArtifactsForMessage(container, '<section><p>Recovered content</p></section>', {
        messageId: 'recover-message',
        isStreaming: false,
    });
    const frame = container.querySelector('.live-artifact-inline-iframe');
    assert.ok(frame);
    const original = frame.getAttribute('srcdoc') || '';
    assert.match(original, /Recovered content/);

    // Simulate Chrome discarding the iframe nested document while keeping the srcdoc attribute.
    frame.srcdoc = original;

    rebuildLiveArtifactFrames();

    // The frame node is replaced with a fresh one (new browsing context).
    const rebuiltFrame = container.querySelector('.live-artifact-inline-iframe');
    assert.notEqual(rebuiltFrame, frame, 'frame node is replaced');
    const rebuilt = rebuiltFrame.getAttribute('srcdoc') || '';
    assert.match(rebuilt, /Recovered content/);
    assert.match(rebuilt, /live-artifact-reload/);
    assert.notEqual(rebuilt, original);
});

test('rebuildLiveArtifactFrames re-pushes streaming content after reload', () => {
    installBrowserGlobals('<!doctype html><body><div id="message"></div></body>');
    const container = document.getElementById('message');
    const html = '<section><h2>Live</h2><p>body</p></section>';

    renderLiveArtifactsForMessage(container, html, {
        messageId: 'recover-stream',
        isStreaming: true,
    });
    const frame = container.querySelector('.live-artifact-inline-iframe');
    assert.ok(frame);

    const posts = [];
    Object.defineProperty(frame, 'contentWindow', {
        configurable: true,
        value: { postMessage: (data) => posts.push(data) },
    });

    rebuildLiveArtifactFrames();

    // Frame node is replaced; the fresh node inherits the pending-stream state.
    const newFrame = container.querySelector('.live-artifact-inline-iframe');
    assert.notEqual(newFrame, frame, 'frame node is replaced');
    assert.match(newFrame.getAttribute('srcdoc') || '', /live-artifact-reload/);
    assert.match(newFrame.dataset.liveArtifactPendingStreamHtml || '', /body/);
});

test('pingAndRebuildDeadArtifactFrames rebuilds only frames that do not answer pong', async () => {
    installBrowserGlobals('<!doctype html><body><div id="message"></div></body>');
    const container = document.getElementById('message');
    const hooks = __liveArtifactsTestHooks;

    renderLiveArtifactsForMessage(container, '<section><h1>ALIVE</h1></section>', {
        messageId: 'ping-alive',
        isStreaming: false,
    });
    const aliveFrame = container.querySelector('.live-artifact-inline-iframe');

    // Simulate Chrome discarding the second frame's document: contentWindow is gone
    // so a ping can never be answered, but the node stays connected.
    const deadHolder = document.createElement('div');
    container.appendChild(deadHolder);
    deadHolder.innerHTML = '<div class="live-artifact-inline-frame"><div class="live-artifact-inline-viewport"><iframe class="live-artifact-inline-iframe"></iframe></div></div>';
    const deadFrame = deadHolder.querySelector('iframe');
    deadFrame.dataset.liveArtifactFrameId = 'ping-dead-frame';
    deadFrame.dataset.liveArtifactMountedAt = String(Date.now() - 10000); // aged past mount guard
    deadFrame.dataset.liveArtifactLoaded = '1';
    deadFrame.srcdoc = '<!doctype html><html><body><div>DEAD</div></body></html>';
    Object.defineProperty(deadFrame, 'contentWindow', {
        value: null, // never answers ping
        configurable: true,
    });

    // aliveFrame answers pong.
    Object.defineProperty(aliveFrame, 'contentWindow', {
        value: {
            postMessage(data) {
                if (data?.event === 'ping') {
                    window.dispatchEvent(new MessageEvent('message', {
                        data: { channel: 'justsearch-live-artifacts', event: 'pong', frameId: data.frameId },
                        source: aliveFrame.contentWindow,
                    }));
                }
            },
        },
        configurable: true,
    });

    // Trigger the recovery manually. It pings every frame and, after its 1.5s
    // window, replaces only the frames that did not answer `pong`.
    hooks.pingAndRebuildDeadArtifactFrames();

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const framesAfter = container.querySelectorAll('.live-artifact-inline-iframe');
    const aliveStillPresent = Array.from(framesAfter).some((f) => f === aliveFrame);
    const deadStillPresent = Array.from(framesAfter).some((f) => f === deadFrame);

    assert.equal(aliveStillPresent, true, 'healthy frame must not be replaced');
    assert.equal(deadStillPresent, false, 'dead frame must be replaced');
});

test('pingAndRebuildArtifactFrame rebuilds only the dead frame that scrolls into view', async () => {
    installBrowserGlobals('<!doctype html><body><div id="message"></div></body>');
    const container = document.getElementById('message');
    const hooks = __liveArtifactsTestHooks;

    renderLiveArtifactsForMessage(container, '<section><h1>ALIVE</h1></section>', {
        messageId: 'view-alive',
        isStreaming: false,
    });
    const aliveFrame = container.querySelector('.live-artifact-inline-iframe');

    const deadHolder = document.createElement('div');
    container.appendChild(deadHolder);
    deadHolder.innerHTML = '<div class="live-artifact-inline-frame"><div class="live-artifact-inline-viewport"><iframe class="live-artifact-inline-iframe"></iframe></div></div>';
    const deadFrame = deadHolder.querySelector('iframe');
    deadFrame.dataset.liveArtifactFrameId = 'view-dead-frame';
    deadFrame.dataset.liveArtifactMountedAt = String(Date.now() - 10000);
    deadFrame.dataset.liveArtifactLoaded = '1';
    deadFrame.srcdoc = '<!doctype html><html><body><div>DEAD</div></body></html>';
    Object.defineProperty(deadFrame, 'contentWindow', {
        value: null,
        configurable: true,
    });

    // aliveFrame answers pong.
    Object.defineProperty(aliveFrame, 'contentWindow', {
        value: {
            postMessage(data) {
                if (data?.event === 'ping') {
                    window.dispatchEvent(new MessageEvent('message', {
                        data: { channel: 'justsearch-live-artifacts', event: 'pong', frameId: data.frameId },
                        source: aliveFrame.contentWindow,
                    }));
                }
            },
        },
        configurable: true,
    });

    // Simulate the IntersectionObserver path: the dead frame scrolls into view
    // and is pinged individually. The healthy frame is NOT pinged at all here —
    // only the single target frame is checked.
    hooks.pingAndRebuildArtifactFrame(deadFrame);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const framesAfter = container.querySelectorAll('.live-artifact-inline-iframe');
    const aliveStillPresent = Array.from(framesAfter).some((f) => f === aliveFrame);
    const deadStillPresent = Array.from(framesAfter).some((f) => f === deadFrame);

    assert.equal(aliveStillPresent, true, 'untouched healthy frame must remain');
    assert.equal(deadStillPresent, false, 'dead frame scrolled into view must be rebuilt');
});

test('bridge stream-render patches incrementally, preserving DOM node identity', () => {
    // Extract the injected preview bridge from a streaming shell srcdoc and run
    // it against an iframe-like jsdom document, then feed it two stream-render
    // payloads. The second must patch in place (same <section> element) rather
    // than replaceChildren — the old all-or-nothing rebuild dropped focus /
    // scroll / expanded-details state on every chunk.
    const shellSrcDoc = buildSrcdoc('<div data-amc-stream-preview-root="true"></div>', 'html', [], {
        frameId: 'patch-identity',
    });
    const bridgeScript = [...shellSrcDoc.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1])
        .find((script) => script.includes('renderStreamHtml'));
    assert.ok(bridgeScript, 'bridge should define renderStreamHtml');

    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(
        '<!doctype html><html><head></head><body><div data-amc-stream-preview-root="true"></div></body></html>',
        { url: 'about:blank', runScripts: 'outside-only' },
    );
    const { window } = dom;
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    window.parent = { postMessage: () => {} };

    const execInWindowScope = new window.Function('window', `with (window) { ${bridgeScript} }`);
    execInWindowScope(window);

    const root = window.document.querySelector('[data-amc-stream-preview-root]');
    assert.ok(root, 'stream root should exist');

    // First stream-render: empty root → wholesale replace.
    window.dispatchEvent(new window.MessageEvent('message', {
        data: { channel: 'justsearch-live-artifacts', event: 'stream-render', html: '<section data-state="keep"><p>First chunk</p></section>' },
    }));
    const firstParagraph = root.querySelector('p');
    assert.equal(firstParagraph?.textContent, 'First chunk', 'first render populates content');

    // Second stream-render: structurally identical → incremental patch keeps the
    // <section> element (only the text inside <p> changes in place).
    const section = root.querySelector('section');
    window.dispatchEvent(new window.MessageEvent('message', {
        data: { channel: 'justsearch-live-artifacts', event: 'stream-render', html: '<section data-state="keep"><p>Second chunk more text</p></section>' },
    }));
    const section2 = root.querySelector('section');
    assert.equal(section2, section, 'section element identity preserved (incremental patch, not replaceChildren)');
    assert.equal(section2.getAttribute('data-state'), 'keep', 'matching attribute preserved');
    assert.equal(section2.querySelector('p').textContent, 'Second chunk more text', 'text updated in place');

    // Third: node removed in the payload → removed from the live DOM.
    window.dispatchEvent(new window.MessageEvent('message', {
        data: { channel: 'justsearch-live-artifacts', event: 'stream-render', html: '<section data-state="keep"></section>' },
    }));
    assert.equal(root.querySelector('p'), null, 'removed node is removed');
    assert.equal(root.querySelector('section'), section, 'section survives when only children change');
});
