import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function installBrowserGlobals(html) {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(html, { url: 'http://localhost/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.Node = dom.window.Node;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.history = dom.window.history;
    globalThis.location = dom.window.location;
    const raf = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.requestAnimationFrame = raf;
    dom.window.requestAnimationFrame = raf;
    Object.defineProperty(globalThis, 'navigator', {
        value: dom.window.navigator,
        configurable: true,
    });
    window.markdownit = () => ({
        render: (value) => String(value || ''),
        utils: { escapeHtml: (value) => String(value || '') },
    });
    window.DOMPurify = { sanitize: (value) => String(value || '') };
    window.hljs = { getLanguage: () => false };
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    if (!dom.window.HTMLElement.prototype.scrollTo) {
        dom.window.HTMLElement.prototype.scrollTo = function scrollTo() {};
    }
    return dom;
}

const CHAT_HTML = `
<!doctype html>
<body>
  <div id="chat-container"></div>
  <button id="scroll-to-bottom-btn"></button>
  <section id="hero-section"></section>
  <div id="input-area">
    <div id="edit-message-banner" class="edit-message-banner" hidden>
      <div class="edit-message-banner-copy">
        <span id="edit-message-banner-text">editing</span>
      </div>
      <button type="button" id="cancel-edit-btn">取消</button>
    </div>
    <textarea id="user-input"></textarea>
    <button id="send-btn"><span class="material-symbols-rounded">send</span></button>
  </div>
  <button id="new-chat-btn"></button>
  <select id="model-select">
    <option value="model-a" data-provider-id="provider-a">Model A</option>
  </select>
</body>
`;

test('editing state fills composer and shows AMC edit chrome', async () => {
    installBrowserGlobals(CHAT_HTML);
    const {
        setEditingMessage,
        clearEditingMessage,
        isEditingMessage,
        state,
    } = await import('../../backend/static/js/modules/state.js?v=5');

    assert.equal(isEditingMessage(), false);
    setEditingMessage(2, 'resend');
    assert.equal(state.editingMessageIndex, 2);
    assert.equal(state.editMode, 'resend');
    assert.equal(isEditingMessage(), true);
    clearEditingMessage();
    assert.equal(isEditingMessage(), false);
    assert.equal(state.editMode, 'resend');
});

test('user edit button stages resend edit via onEdit callback', async () => {
    installBrowserGlobals(CHAT_HTML);
    const { elements, appendMessage, initUI } = await import('../../backend/static/js/modules/ui.js?v=43');
    initUI();
    Object.assign(elements, {
        chatContainer: document.getElementById('chat-container'),
        heroSection: document.getElementById('hero-section'),
        userInput: document.getElementById('user-input'),
        sendBtn: document.getElementById('send-btn'),
        editMessageBanner: document.getElementById('edit-message-banner'),
        cancelEditBtn: document.getElementById('cancel-edit-btn'),
        editMessageBannerText: document.getElementById('edit-message-banner-text'),
        inputArea: document.getElementById('input-area'),
    });

    let editPayload = null;
    appendMessage('user', '原始问题内容', null, null, null, 0, null, {
        onEdit: (payload) => { editPayload = payload; },
    });

    const editBtn = document.querySelector('[data-action="edit-message"]');
    assert.ok(editBtn, 'edit button present on user message');
    editBtn.click();
    assert.ok(editPayload);
    assert.equal(editPayload.content, '原始问题内容');
    assert.equal(editPayload.messageIndex, 0);
    assert.equal(editPayload.mode, 'resend');
});

test('assistant regenerate passes previous user index for AMC truncate', async () => {
    installBrowserGlobals(CHAT_HTML);
    const { elements, renderMessages, initUI } = await import('../../backend/static/js/modules/ui.js?v=43');
    initUI();
    Object.assign(elements, {
        chatContainer: document.getElementById('chat-container'),
        heroSection: document.getElementById('hero-section'),
        userInput: document.getElementById('user-input'),
        sendBtn: document.getElementById('send-btn'),
    });

    let regenArgs = null;
    renderMessages(
        [
            { role: 'user', content: '第一问' },
            { role: 'assistant', content: '第一答' },
            { role: 'user', content: '第二问' },
            { role: 'assistant', content: '第二答' },
        ],
        {
            onRegenerate: (prompt, meta) => {
                regenArgs = { prompt, meta };
            },
        },
    );

    const regenBtns = document.querySelectorAll('[data-action="regenerate-message"]');
    assert.equal(regenBtns.length, 2);
    regenBtns[1].click();
    assert.ok(regenArgs);
    assert.equal(regenArgs.prompt, '第二问');
    assert.equal(regenArgs.meta.previousUserIndex, 2);
    assert.equal(regenArgs.meta.messageIndex, 3);
});

test('streamChat includes truncate_from_index when editing/resending', async () => {
    installBrowserGlobals(CHAT_HTML);
    const originalFetch = globalThis.fetch;
    let requestBody = null;
    try {
        const { state } = await import('../../backend/static/js/modules/state.js?v=5');
        const { streamChat } = await import('../../backend/static/js/modules/api.js?v=14');
        state.currentSessionId = 'sess-edit';
        state.settings = {
            default_provider_id: 'provider-a',
            search_engine: 'google',
            max_results: 10,
            max_iterations: 3,
            interactive_search: true,
        };

        globalThis.fetch = async (_input, init) => {
            requestBody = JSON.parse(init.body);
            return new Response('data: [DONE]\n\n', {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
            });
        };

        await streamChat('改写后的问题', {
            model: 'model-a',
            providerId: 'provider-a',
            sessionId: 'sess-edit',
            truncateFromIndex: 2,
            liveArtifactsMode: false,
        });

        assert.equal(requestBody.query, '改写后的问题');
        assert.equal(requestBody.session_id, 'sess-edit');
        assert.equal(requestBody.truncate_from_index, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
