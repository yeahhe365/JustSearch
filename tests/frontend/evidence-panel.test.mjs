/**
 * Live Artifact iframe citations must resolve sources/citations by frameId;
 * there is no module-level last-rendered-message fallback.
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
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.MessageEvent = dom.window.MessageEvent;
    Object.defineProperty(globalThis, 'navigator', {
        value: dom.window.navigator,
        configurable: true,
    });
    return dom;
}

function evidenceModuleUrl(cacheBust = Date.now()) {
    return pathToFileURL(path.join(root, 'backend/static/js/modules/evidence-panel.js')).href + `?t=${cacheBust}`;
}

test('iframe citation-click uses frameId context, never last-message state', async () => {
    installBrowserGlobals();
    const {
        initEvidencePanel,
        setFrameEvidenceContext,
        openEvidencePanel,
    } = await import(evidenceModuleUrl());

    initEvidencePanel();

    const oldSources = [{ id: '1', title: 'Old Source', url: 'https://example.com/old', excerpt: 'old quote' }];
    const oldCitations = [{
        source_id: '1',
        occurrence_id: 'occ-old',
        claim: 'old claim',
        quote: 'old quote text',
        status: 'supported',
        claim_index: 0,
    }];
    const newSources = [{ id: '1', title: 'New Source', url: 'https://example.com/new', excerpt: 'new quote' }];
    const newCitations = [{
        source_id: '1',
        occurrence_id: 'occ-new',
        claim: 'new claim',
        quote: 'new quote text',
        status: 'supported',
        claim_index: 0,
    }];

    // Register per-frame contexts (old message + latest message).
    setFrameEvidenceContext('msg-old-inline-0', { sources: oldSources, citations: oldCitations });
    setFrameEvidenceContext('msg-new-inline-0', { sources: newSources, citations: newCitations });

    // Simulate iframe postMessage from the OLD artifact frame.
    window.dispatchEvent(new MessageEvent('message', {
        data: {
            channel: 'justsearch-live-artifacts',
            event: 'citation-click',
            sourceId: '1',
            occurrenceId: 'occ-old',
            frameId: 'msg-old-inline-0',
        },
    }));

    const body = document.getElementById('evidence-panel-body');
    assert.ok(body, 'evidence panel body should exist');
    assert.match(body.textContent, /old claim|old quote text/, 'should show old message evidence');
    assert.doesNotMatch(body.textContent, /new claim|new quote text/, 'must not show latest-message evidence');

    // Unregistered frameId (stale iframe) must be ignored instead of falling
    // back to a last-rendered-message context.
    window.dispatchEvent(new MessageEvent('message', {
        data: {
            channel: 'justsearch-live-artifacts',
            event: 'citation-click',
            sourceId: '1',
            occurrenceId: 'occ-old',
            frameId: 'frame-never-registered',
        },
    }));
    assert.match(body.textContent, /old claim|old quote text/, 'unregistered frame must not replace the panel');

    // Sanity: open with explicit context still works.
    openEvidencePanel({
        sourceId: '1',
        sources: newSources,
        citations: newCitations,
    });
    assert.match(body.textContent, /new claim|new quote text/);
});

test('setFrameEvidenceContext overwrites prior registration for same frameId', async () => {
    installBrowserGlobals();
    const {
        initEvidencePanel,
        setFrameEvidenceContext,
        getFrameEvidenceContext,
    } = await import(evidenceModuleUrl());

    initEvidencePanel();
    setFrameEvidenceContext('frame-a', {
        sources: [{ id: '1', title: 'A' }],
        citations: [{ source_id: '1', quote: 'first' }],
    });
    setFrameEvidenceContext('frame-a', {
        sources: [{ id: '1', title: 'B' }],
        citations: [{ source_id: '1', quote: 'second' }],
    });

    const ctx = getFrameEvidenceContext('frame-a');
    assert.equal(ctx.sources[0].title, 'B');
    assert.equal(ctx.citations[0].quote, 'second');
});

test('frameContexts cache is bounded and evicts oldest entries', async () => {
    installBrowserGlobals();
    const {
        initEvidencePanel,
        setFrameEvidenceContext,
        getFrameEvidenceContext,
        // Internal map exported only for the test harness.
        // eslint-disable-next-line no-underscore-dangle
    } = await import(evidenceModuleUrl());

    initEvidencePanel();
    // Register 120 distinct frames; the cache must stay <= 100, and the
    // most-recently-registered frame must still be readable.
    for (let i = 0; i < 120; i++) {
        setFrameEvidenceContext(`frame-${i}`, {
            sources: [{ id: `${i}`, title: `T${i}` }],
            citations: [],
        });
    }
    // The newest registration must survive eviction.
    const newest = getFrameEvidenceContext('frame-119');
    assert.ok(newest, 'newest frame context must survive eviction');
    assert.equal(newest.sources[0].title, 'T119');
    // The oldest (frame-0) was the first to be evicted.
    assert.equal(getFrameEvidenceContext('frame-0'), null);
    // A freshly registered frame after saturation is still readable.
    setFrameEvidenceContext('frame-extra', {
        sources: [{ id: 'x', title: 'Extra' }],
        citations: [],
    });
    assert.equal(getFrameEvidenceContext('frame-extra').sources[0].title, 'Extra');
});
