/**
 * Phase 1: incremental-stream gate (shouldRenderStreamTick).
 *
 * The throttled timer must NOT run the full render pipeline for every tiny
 * delta — only when content grew enough, hit a block boundary, went stale, or
 * is the very first push. This keeps per-tick work decoupled from total
 * accumulated length (avoids O(n²) re-renders while streaming).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

// chat.js imports modules that touch i18n / state, so bootstrap a minimal DOM
// the same way the other frontend tests do before importing it.
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.location = dom.window.location;
globalThis.Event = dom.window.Event;
window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
window.markdownit = () => ({ render: (v) => String(v || ''), utils: { escapeHtml: (v) => String(v || '') } });
window.DOMPurify = { sanitize: (v) => String(v || '') };
window.hljs = { getLanguage: () => false };

const { shouldRenderStreamTick } = await import(
    pathToFileURL(path.join(root, 'backend/static/js/modules/chat.js')).href + `?t=${Date.now()}`
);

const NOW = 10_000;

test('no content change → do not render', () => {
    assert.equal(
        shouldRenderStreamTick({
            length: 100,
            lastPushedLength: 100,
            buffer: 'x'.repeat(100),
            now: NOW,
            lastPushTime: NOW - 100,
        }),
        false,
        'identical length must not re-render even after staleness window',
    );
});

test('first push renders promptly even for tiny content', () => {
    assert.equal(
        shouldRenderStreamTick({
            length: 5,
            lastPushedLength: 0,
            buffer: 'hello',
            now: NOW,
            lastPushTime: NOW,
        }),
        true,
        'first-ever content must appear without waiting for delta/boundary',
    );
});

test('small delta with no block boundary and fresh (<800ms) → do not render', () => {
    assert.equal(
        shouldRenderStreamTick({
            length: 100,
            lastPushedLength: 80,
            buffer: 'x'.repeat(100),
            now: NOW,
            lastPushTime: NOW - 200,
        }),
        false,
        '20-char delta, no boundary, 200ms stale → skip',
    );
});

test('large delta (>=400 chars) renders', () => {
    assert.equal(
        shouldRenderStreamTick({
            length: 500,
            lastPushedLength: 80,
            buffer: 'x'.repeat(500),
            now: NOW,
            lastPushTime: NOW - 50,
        }),
        true,
        '420-char delta must render even without boundary or staleness',
    );
});

test('block boundary (\n\n) renders even with small delta', () => {
    assert.equal(
        shouldRenderStreamTick({
            length: 90,
            lastPushedLength: 80,
            buffer: 'x'.repeat(80) + '\n\nparagraph two',
            now: NOW,
            lastPushTime: NOW - 50,
        }),
        true,
        'new paragraph boundary must render the accumulated block',
    );
});

test('code-fence boundary (```) renders even with small delta', () => {
    assert.equal(
        shouldRenderStreamTick({
            length: 90,
            lastPushedLength: 80,
            buffer: 'x'.repeat(80) + '\n```js',
            now: NOW,
            lastPushTime: NOW - 50,
        }),
        true,
        'entering a code fence must render',
    );
});

test('stale beyond 800ms renders regardless of delta', () => {
    assert.equal(
        shouldRenderStreamTick({
            length: 95,
            lastPushedLength: 80,
            buffer: 'x'.repeat(95),
            now: NOW,
            lastPushTime: NOW - 1000,
        }),
        true,
        'stale content must not wait for the next delta boundary',
    );
});

test('custom thresholds are honored', () => {
    assert.equal(
        shouldRenderStreamTick({
            length: 60,
            lastPushedLength: 0,
            buffer: 'x'.repeat(60),
            now: NOW,
            lastPushTime: NOW,
            minDeltaChars: 100,
        }),
        true,
        'first push ignores custom minDelta',
    );
});
