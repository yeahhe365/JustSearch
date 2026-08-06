import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  renderLiveArtifactsForMessage,
  __liveArtifactsTestHooks,
} from '../../backend/static/js/modules/live-artifacts.js';

const { handleArtifactFrameMessage, applyInlineArtifactFrameHeight, measureArtifactContentHeight } = __liveArtifactsTestHooks;

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body><div id="message"></div><textarea id="user-input"></textarea></body>', {
  url: 'http://localhost/',
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;
globalThis.DOMParser = dom.window.DOMParser;

const container = document.getElementById('message');
const html = '<section style="display:block;width:100%;box-sizing:border-box"><h2>Inline Artifact</h2><p>Rendered inside iframe</p><p>Second paragraph for height.</p></section>';
const artifacts = renderLiveArtifactsForMessage(container, html, {
  messageId: 'dom-check-message',
  isStreaming: false,
});

assert.equal(artifacts.length, 1);
assert.equal(container.querySelectorAll('[data-live-artifact-frame="true"]').length, 1);
assert.equal(container.querySelectorAll('iframe[title="HTML Preview"]').length, 1);
assert.equal(container.querySelectorAll('section').length, 0);
const inlineFrame = container.querySelector('iframe');
const inlineViewport = container.querySelector('.live-artifact-inline-viewport');
assert.match(inlineFrame.getAttribute('srcdoc'), /Inline Artifact/);
assert.match(inlineFrame.getAttribute('srcdoc'), /data-amc-preview-base/);
assert.match(inlineFrame.getAttribute('srcdoc'), /notifyResize/);
// The injected bridge must stay a valid script. Its regexes live inside a JS
// template literal, where '\/' would be unescaped to '/' and break the parse
// (the '/' starts a comment, silently killing the whole bridge). Guard both
// the anchor interceptor presence and the escaped-slash form.
const srcdoc = inlineFrame.getAttribute('srcdoc');
assert.match(srcdoc, /Generic external links/);
assert.match(srcdoc, /\\\/\\\//i);
assert.doesNotMatch(srcdoc, /https\?:\/\/\/i/);
assert.equal(inlineFrame.getAttribute('scrolling'), 'no');
assert.equal(
  inlineFrame.getAttribute('sandbox'),
  'allow-scripts allow-forms allow-popups allow-modals allow-downloads',
);
assert.equal(inlineFrame.dataset.liveArtifactFrameId, 'dom-check-message-inline-0');
assert.match(inlineFrame.getAttribute('srcdoc'), /const FRAME_ID = "dom-check-message-inline-0"/);
// Parent-side probe should have already set a concrete height (not stuck at 0).
assert.match(inlineViewport.style.height, /^\d+px$/);
assert.ok(parseInt(inlineViewport.style.height, 10) >= 120);

Object.defineProperty(inlineFrame, 'contentWindow', {
  configurable: true,
  value: { id: 'dom-check-inline-window' },
});
handleArtifactFrameMessage({
  source: { id: 'unrelated' },
  data: {
    channel: 'justsearch-live-artifacts',
    event: 'resize',
    height: 2048,
    frameId: 'dom-check-message-inline-0',
  },
});
assert.equal(inlineViewport.style.height, '2056px');
assert.equal(inlineFrame.style.height, '2056px');
assert.equal(applyInlineArtifactFrameHeight(inlineViewport, inlineFrame, 40), 120);
assert.ok(measureArtifactContentHeight(html, 640) >= 120);

const interaction = {
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
      outline: { type: 'boolean', title: '先生成大纲', default: true },
      words: { type: 'integer', title: '目标字数', default: 2000 },
    },
  },
};

renderLiveArtifactsForMessage(container, `\`\`\`amc-live-artifact-interaction\n${JSON.stringify(interaction)}\n\`\`\``, {
  messageId: 'interaction-message',
  isStreaming: false,
});

const form = container.querySelector('[data-live-artifact-interaction="true"]');
assert.ok(form);
assert.equal(container.querySelector('input[name="topic"]').value, '');
assert.equal(container.querySelector('select[name="style"]').value, 'APA');
assert.equal(container.querySelector('input[name="outline"]').checked, true);
assert.equal(container.querySelector('input[name="words"]').value, '2000');
container.querySelector('input[name="topic"]').value = '人工智能辅助学术写作';
form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
assert.match(document.getElementById('user-input').value, /请根据 Live Artifact 中的交互选择继续处理/);
assert.match(document.getElementById('user-input').value, /人工智能辅助学术写作/);
assert.match(document.getElementById('user-input').value, /amc-live-artifact-interaction:v1/);

document.getElementById('user-input').value = '';
renderLiveArtifactsForMessage(container, '<section><button>可信 iframe 消息源</button></section>', {
  messageId: 'trusted-message-source',
  isStreaming: false,
});
const trustedFrame = container.querySelector('.live-artifact-inline-iframe');
assert.ok(trustedFrame);

dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
  data: {
    channel: 'justsearch-live-artifacts',
    event: 'followup',
    payload: {
      instruction: '伪造消息',
      state: {
        selected: 'A',
        amount: 3,
      },
    },
  },
}));
assert.equal(document.getElementById('user-input').value, '');

handleArtifactFrameMessage({
  source: trustedFrame.contentWindow,
  data: {
    channel: 'justsearch-live-artifacts',
    event: 'followup',
    payload: {
      instruction: '继续优化',
      state: {
        selected: 'B',
        amount: 3,
      },
    },
  },
});
assert.match(document.getElementById('user-input').value, /继续优化/);
assert.match(document.getElementById('user-input').value, /"selected": "B"/);
assert.match(document.getElementById('user-input').value, /"amount": 3/);

console.log('inline and interaction live artifact DOM checks passed');
