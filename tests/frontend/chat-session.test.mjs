/**
 * Regression: starting a new chat while a stream is in-flight must not let
 * late SSE re-bind currentSessionId, or the next message appends to history.
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

function installBrowserGlobals(html = '<!doctype html><body></body>') {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(html, { url: 'http://localhost/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;
    globalThis.location = dom.window.location;
    globalThis.Event = dom.window.Event;
    // jsdom lacks matchMedia; stub it so handleSendMessage's reduced-motion probe works.
    window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    if (!dom.window.HTMLElement.prototype.scrollTo) {
        dom.window.HTMLElement.prototype.scrollTo = function scrollTo(options = {}) {
            if (typeof options === 'object' && options !== null && Number.isFinite(options.top)) {
                this.scrollTop = options.top;
            }
        };
    }
    window.markdownit = () => ({
        render: (value) => String(value || ''),
        utils: { escapeHtml: (value) => String(value || '') },
    });
    window.DOMPurify = { sanitize: (value) => String(value || '') };
    window.hljs = { getLanguage: () => false };
    return dom;
}

function stateModuleUrl() {
    return pathToFileURL(path.join(root, 'backend/static/js/modules/state.js')).href + '?v=4';
}

function apiModuleUrl() {
    return pathToFileURL(path.join(root, 'backend/static/js/modules/api.js')).href + '?v=9';
}

test('abandonActiveChatWork can be called without uiElements (no ReferenceError)', async () => {
    installBrowserGlobals();
    const chatUrl = pathToFileURL(path.join(root, 'backend/static/js/modules/chat.js')).href + `?t=${Date.now()}`;
    // chat.js pulls many UI deps; stub the heavy ones that touch DOM at import time if needed.
    const { abandonActiveChatWork } = await import(chatUrl);
    assert.equal(typeof abandonActiveChatWork, 'function');
    // Pre-fix: default param referenced undefined module-scope `elements` → ReferenceError.
    assert.doesNotThrow(() => abandonActiveChatWork());
});

test('chatEpoch bump isolates abandoned stream session rebinding', async () => {
    installBrowserGlobals();
    const {
        state,
        setCurrentSessionId,
        bumpChatEpoch,
        isChatEpochCurrent,
        abortActiveStream,
        setAbortController,
        setIsProcessing,
    } = await import(stateModuleUrl());

    setCurrentSessionId('old-session');
    setIsProcessing(true);
    const controller = new AbortController();
    setAbortController(controller);

    const streamEpoch = state.chatEpoch;
    assert.equal(isChatEpochCurrent(streamEpoch), true);

    // Simulate "new chat": abort + bump + clear session
    abortActiveStream();
    bumpChatEpoch();
    setCurrentSessionId(null);

    assert.equal(controller.signal.aborted, true);
    assert.equal(state.isProcessing, false);
    assert.equal(state.currentSessionId, null);
    assert.equal(isChatEpochCurrent(streamEpoch), false);

    // Late SSE answer from old stream must not reclaim session when guarded.
    if (isChatEpochCurrent(streamEpoch)) {
        setCurrentSessionId('old-session');
    }
    assert.equal(state.currentSessionId, null);
});

test('streamChat freezes explicit sessionId in request body', async () => {
    installBrowserGlobals();
    const { state, setCurrentSessionId } = await import(stateModuleUrl());
    const { streamChat } = await import(apiModuleUrl());

    setCurrentSessionId('live-session');

    let postedBody = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options = {}) => {
        postedBody = JSON.parse(options.body);
        // Mid-flight: user switched to new chat and cleared session.
        setCurrentSessionId(null);
        return {
            ok: true,
            body: {
                getReader() {
                    return {
                        async read() {
                            return { done: true, value: undefined };
                        },
                    };
                },
            },
        };
    };

    try {
        await streamChat('hello', {
            sessionId: 'live-session',
            model: 'm',
            providerId: 'p',
            liveArtifactsMode: false,
            onLog() {},
            onAnswerChunk() {},
            onAnswer() {},
            onSources() {},
            onStats() {},
            onError() {},
            onDone() {},
            onMeta() {},
        });
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.ok(postedBody, 'expected chat request body');
    assert.equal(postedBody.session_id, 'live-session');
    assert.equal(state.currentSessionId, null);
});

test('streamChat with null sessionId starts a new conversation', async () => {
    installBrowserGlobals();
    const { setCurrentSessionId } = await import(stateModuleUrl());
    const { streamChat } = await import(apiModuleUrl());

    setCurrentSessionId('should-not-be-used');

    let postedBody = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options = {}) => {
        postedBody = JSON.parse(options.body);
        return {
            ok: true,
            body: {
                getReader() {
                    return {
                        async read() {
                            return { done: true, value: undefined };
                        },
                    };
                },
            },
        };
    };

    try {
        await streamChat('new topic', {
            sessionId: null,
            onDone() {},
        });
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(postedBody.session_id, null);
});

test('detachCurrentStream keeps an in-flight stream running (background), abandon aborts it', async () => {
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <select id="model-select"><option value="model-a" data-provider-id="provider-a">Model A</option></select>
            <button id="send-btn"><span class="material-symbols-rounded">send</span></button>
            <textarea id="user-input"></textarea>
            <div id="chat-container"></div>
            <section id="hero-section"></section>
            <button id="new-chat-btn"></button>
        </body>
    `);
    const originalFetch = globalThis.fetch;
    // Import state with the SAME ?v= hash chat.js uses (v=5), otherwise the two
    // are distinct module instances and our setters never reach the one chat.js reads.
    const { state, setCurrentSessionId, setLiveArtifactsMode } = await import(
        pathToFileURL(path.join(root, 'backend/static/js/modules/state.js')).href + '?v=5'
    );
    const uiUrl = pathToFileURL(path.join(root, 'backend/static/js/modules/ui.js')).href + '?v=43';
    const { elements } = await import(uiUrl);
    const chatUrl = pathToFileURL(path.join(root, 'backend/static/js/modules/chat.js')).href + `?t=${Date.now()}`;
    const { setupChatHandler, detachCurrentStream, abandonActiveChatWork } = await import(chatUrl);

    setCurrentSessionId(null);
    setLiveArtifactsMode(false);
    state.settings = {
        default_provider_id: 'provider-a',
        search_engine: 'google',
        max_results: 10,
        max_iterations: 3,
        interactive_search: true,
    };

    // SSE stream that stays open so the search stays in-flight.
    globalThis.fetch = async (input) => {
        const url = String(input);
        if (url === '/api/chat') {
            const encoder = new TextEncoder();
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(
                        `data: ${JSON.stringify({ type: 'meta', session_id: 'detach-session' })}\n\n`,
                    ));
                    // keep the stream open — never close
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
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('send-btn').click();

    // Wait until the stream is in-flight and owns the view.
    for (let i = 0; i < 50; i += 1) {
        if (state.isProcessing && state.abortController) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(state.isProcessing, true, 'stream should be in-flight');
    const controller = state.abortController;
    assert.ok(controller, 'abortController should be set');
    assert.equal(controller.signal.aborted, false);

    // Switch away: detach keeps the stream running in the background.
    detachCurrentStream(testElements);
    assert.equal(state.isProcessing, false, 'view is idle after switching away');
    assert.equal(state.abortController, null, 'no abort controller owns the new view');
    assert.equal(controller.signal.aborted, false, 'detach must NOT abort the stream');

    globalThis.fetch = originalFetch;
});


test('resetChatDomToHero clears the container, restores hero, and can focus composer', async () => {
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <div id="chat-container"><div class="message">stale</div></div>
            <section id="hero-section" style="display:none"></section>
            <input id="user-input">
        </body>
    `);
    const uiUrl = pathToFileURL(path.join(root, 'backend/static/js/modules/ui.js')).href + `?v=43&t=${Date.now()}`;
    const ui = await import(uiUrl);
    ui.elements.chatContainer = document.getElementById('chat-container');
    ui.elements.heroSection = document.getElementById('hero-section');
    ui.elements.userInput = document.getElementById('user-input');

    // Precondition: container holds stale message DOM and hero is hidden.
    assert.ok(document.querySelector('#chat-container .message'), 'stale message present');
    document.body.appendChild(ui.elements.heroSection);

    let focused = false;
    ui.elements.userInput.focus = () => { focused = true; };

    ui.resetChatDomToHero();

    const container = document.getElementById('chat-container');
    const hero = document.getElementById('hero-section');
    assert.equal(container.querySelectorAll('.message').length, 0, 'container cleared');
    assert.equal(hero.style.display, 'block', 'hero shown');
    assert.equal(container.contains(hero), true, 'hero re-appended into container');
    assert.equal(focused, false, 'composer not focused without focusComposer');

    ui.resetChatDomToHero({ focusComposer: true });
    assert.equal(focused, true, 'composer focused with focusComposer: true');
});

test('chat.js History API calls go through window.history (bare history breaks module scopes)', async () => {
    // Regression: bare `history.replaceState(...)` resolves via window in browsers,
    // but throws ReferenceError in any JS environment where window exists without
    // a global `history` binding (jsdom-based tests, workers). Pin the invariant.
    const fs = await import('node:fs');
    const src = fs.readFileSync(path.join(root, 'backend/static/js/modules/chat.js'), 'utf8');
    const bare = src.match(/(?<![.\w$])history\.(?:pushState|replaceState|back|forward|go)\b/g) || [];
    assert.deepEqual(bare, [], `bare history.* calls found: ${bare.join(', ')}`);
});

test('detachCurrentStream detaches a freshly started stream (view registration at send)', async () => {
    installBrowserGlobals(`
        <!doctype html>
        <body>
            <select id="model-select"><option value="model-a" data-provider-id="provider-a">Model A</option></select>
            <button id="send-btn"><span class="material-symbols-rounded">send</span></button>
            <textarea id="user-input"></textarea>
            <div id="chat-container"></div>
            <section id="hero-section"></section>
            <button id="new-chat-btn"></button>
        </body>
    `);
    const originalFetch = globalThis.fetch;
    const { state, setCurrentSessionId, setLiveArtifactsMode } = await import(
        pathToFileURL(path.join(root, 'backend/static/js/modules/state.js')).href + '?v=5'
    );
    const uiUrl = pathToFileURL(path.join(root, 'backend/static/js/modules/ui.js')).href + '?v=43';
    const { elements } = await import(uiUrl);
    const chatUrl = pathToFileURL(path.join(root, 'backend/static/js/modules/chat.js')).href + `?t=${Date.now()}`;
    const { setupChatHandler, detachCurrentStream } = await import(chatUrl);

    setCurrentSessionId(null);
    setLiveArtifactsMode(false);
    state.settings = {
        default_provider_id: 'provider-a',
        search_engine: 'google',
        max_results: 10,
        max_iterations: 3,
        interactive_search: true,
    };

    globalThis.fetch = async (input) => {
        const url = String(input);
        if (url === '/api/chat') {
            const encoder = new TextEncoder();
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(
                        `data: ${JSON.stringify({ type: 'meta', session_id: 'fresh-detach-session' })}\n\n`,
                    ));
                    // keep open
                },
            }), { status: 200 });
        }
        if (url === '/api/health') {
            return new Response(JSON.stringify({ bridge: { extension_connected: true } }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (url === '/api/history' || url === '/api/history/groups') {
            return new Response(JSON.stringify([]), { status: 200 });
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
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('send-btn').click();

    for (let i = 0; i < 50; i += 1) {
        if (state.isProcessing && state.abortController) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(state.isProcessing, true, 'stream should be in-flight');
    assert.ok(
        document.querySelector('#chat-container .message'),
        'user bubble appended while streaming',
    );

    // Regression: handleSendMessage must register the new stream as
    // currentViewStream. Before the fix, detachCurrentStream read null and
    // left rec.attached=true, so the background finalizer mutated shared
    // chrome of whichever session was visible next.
    detachCurrentStream(testElements);
    assert.equal(
        document.querySelectorAll('#chat-container .message').length,
        0,
        'freshly started stream must be detached from the view (bubbles removed)',
    );

    globalThis.fetch = originalFetch;
});
