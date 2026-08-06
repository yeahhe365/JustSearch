/**
 * completion-feedback: desktop notification + completion chime (AMC-aligned).
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

function installBrowserGlobals() {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    return dom;
}

function moduleUrl() {
    return pathToFileURL(path.join(root, 'backend/static/js/modules/completion-feedback.js')).href + `?t=${Date.now()}`;
}

test('sanitizeCompletionText strips markdown and caps length', async () => {
    installBrowserGlobals();
    const { sanitizeCompletionText } = await import(moduleUrl());

    assert.equal(sanitizeCompletionText('**粗体** 与 `code`'), '粗体 与 code');
    assert.equal(
        sanitizeCompletionText('# 标题\n> 引用\n- 列表项\n[链接](https://example.com)'),
        '标题 引用 列表项 链接',
    );
    assert.equal(sanitizeCompletionText('<b>html</b>'), 'html');
    const long = 'x'.repeat(200);
    assert.equal(sanitizeCompletionText(long).length, 150, 'capped at max');
});

test('showCompletionNotification no-ops unless permission granted', async () => {
    installBrowserGlobals();
    const created = [];
    const NotificationMock = class Notification {
        static permission = 'default';
        constructor(title, options) { this.title = title; this.options = options; created.push(this); }
        close() { this.closed = true; }
    };
    globalThis.Notification = NotificationMock;
    window.Notification = NotificationMock;

    const { showCompletionNotification } = await import(moduleUrl());

    // Permission not granted → silent no-op, nothing created.
    NotificationMock.permission = 'default';
    assert.equal(showCompletionNotification('搜索完成', 'body'), false);
    assert.equal(created.length, 0, 'no notification created without permission');

    // Granted → created, auto-close scheduled, click focuses window.
    NotificationMock.permission = 'granted';
    let focused = false;
    window.focus = () => { focused = true; };
    const shown = showCompletionNotification('搜索完成', '  已完成 · 12.3s  ');
    assert.equal(shown, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].title, '搜索完成');
    assert.equal(created[0].options.body, '已完成 · 12.3s');
    assert.equal(created[0].options.tag, 'justsearch-completion');

    created[0].onclick();
    assert.equal(focused, true, 'click focuses window');
    assert.equal(created[0].closed, true, 'click closes notification');
});

test('playCompletionSound is a safe no-op without WebAudio and plays notes with it', async () => {
    installBrowserGlobals();
    const { playCompletionSound } = await import(moduleUrl());

    // No AudioContext → must not throw.
    playCompletionSound();

    // Mocked WebAudio → creates 2 oscillators with a gain envelope.
    const nodes = [];
    const ctxMock = {
        state: 'suspended',
        currentTime: 10,
        createOscillator() {
            const node = {
                type: '', frequency: { setValueAtTime() {} },
                connect() {}, start() {}, stop() {},
            };
            nodes.push(node);
            return node;
        },
        createGain() {
            return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
        },
        connect() {},
        destination: {},
        resume: () => Promise.resolve(),
    };
    window.AudioContext = class { constructor() { return ctxMock; } };

    playCompletionSound();
    assert.equal(nodes.length, 2, 'two-tone chime creates two oscillators');
    assert.ok(nodes.every((n) => n.type === 'sine'), 'sine wave notes');
});
