/**
 * live-artifacts external links: clicking an http(s) link inside a Live
 * Artifact iframe must open a new tab, not navigate the frame (AMC behavior).
 * The injected preview bridge intercepts absolute http(s) anchors and calls
 * window.open('_blank'); same-page '#' / citation / source links are left to
 * their dedicated handlers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function renderArtifactSrcdoc(html) {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="m"></div></body>', { url: 'http://localhost/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.DOMParser = dom.window.DOMParser;
    globalThis.MutationObserver = dom.window.MutationObserver;
    globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    return import(pathToFileUrl('backend/static/js/modules/live-artifacts.js')).then(({ renderLiveArtifactsForMessage }) => {
        renderLiveArtifactsForMessage(document.getElementById('m'), html, { messageId: 't', isStreaming: false });
        return document.querySelector('iframe').getAttribute('srcdoc');
    });
}

function pathToFileUrl(rel) {
    const { pathToFileURL } = require('node:url');
    return pathToFileURL(path.join(root, rel)).href;
}

function runSrcdocWithClick(srcdoc, clickSelector) {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(srcdoc, {
        url: 'http://localhost/',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
    });
    const opened = [];
    dom.window.open = (url, target) => {
        opened.push({ url, target });
        return { opener: null };
    };
    const doc = dom.window.document;
    const anchor = doc.querySelector(clickSelector);
    anchor.click();
    return { opened, doc };
}

test('external http(s) links open a new tab instead of navigating the artifact frame', async () => {
    const srcdoc = await renderArtifactSrcdoc(
        '<section><h2>Doc</h2><p><a href="https://help.aliyun.com/zh/model-studio/asr-model">ASR 文档</a></p></section>',
    );
    assert.match(srcdoc, /Generic external links/, 'bridge includes the anchor interceptor');

    const { opened } = runSrcdocWithClick(srcdoc, 'a[href="https://help.aliyun.com/zh/model-studio/asr-model"]');
    assert.equal(opened.length, 1, 'external link opened a new tab');
    assert.equal(opened[0].target, '_blank');
    assert.equal(opened[0].url, 'https://help.aliyun.com/zh/model-studio/asr-model');
});

test('same-page hash and citation links keep their native/dedicated handling', async () => {
    const srcdoc = await renderArtifactSrcdoc(
        '<section><p><a href="#section-2">锚点</a></p>'
        + '<p><a class="live-artifact-citation-link" href="https://example.com/source" data-live-artifact-source-id="1">[1]</a></p></section>',
    );
    const { opened } = runSrcdocWithClick(srcdoc, 'a[href="#section-2"]');
    assert.equal(opened.length, 0, 'hash anchor is not opened in a new tab');
});
