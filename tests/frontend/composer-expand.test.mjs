import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const dom = () => {
  const d = new JSDOM(`<!doctype html><html><body>
    <div class="input-box">
      <div class="composer-resize-handle" role="separator" tabindex="0"><div class="composer-resize-handle-bar"></div></div>
      <div class="composer-expand-corner">
        <span class="composer-expand-corner-line"></span>
        <button type="button" class="composer-expand-btn" aria-pressed="false"></button>
      </div>
      <div class="composer-editor-frame"><textarea id="user-input" style="min-height:26px"></textarea></div>
      <div class="input-toolbar"></div>
    </div></body></html>`, { url: 'http://localhost/' });
  globalThis.window = d.window;
  globalThis.document = d.window.document;
  if (!d.window.requestAnimationFrame) d.window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = d.window.requestAnimationFrame.bind(d.window);
  return d;
};

const moduleUrl = () => pathToFileURL(path.resolve('backend/static/js/modules/composer-expand.js')).href + `?t=${Math.random()}`;

test('expand toggle: corner click expands inline and collapses back', async () => {
  const d = dom();
  const { setupComposerExpand } = await import(moduleUrl());
  const box = document.querySelector('.input-box');
  const textarea = document.getElementById('user-input');
  const frame = box.querySelector('.composer-editor-frame');
  const api = setupComposerExpand({ inputBoxEl: box, textareaEl: textarea });
  assert.ok(api);
  box.querySelector('.composer-expand-btn').click();
  // Sync state flips immediately…
  assert.equal(box.classList.contains('expanded'), true);
  assert.equal(box.querySelector('.composer-expand-btn').getAttribute('aria-pressed'), 'true');
  assert.equal(textarea.dataset.customHeight, 'true');
  // …then the two-phase height animation settles on the expanded target
  // max(220px, 50vh). jsdom's css parser drops max() values, so in tests the
  // computed px fallback (innerHeight*0.5) is what remains on style.height.
  const expectedPx = Math.max(220, Math.round(d.window.innerHeight * 0.5));
  await new Promise((r) => setTimeout(r, 400));
  assert.match(
    frame.style.height,
    new RegExp(`^(${expectedPx}px|max\\(220px, ?50vh\\))$`),
    'expanded target height applied',
  );
  api.toggle();
  assert.equal(box.classList.contains('expanded'), false);
  assert.equal(textarea.dataset.customHeight, 'false');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(frame.style.height, ''); // back to natural autoResize flow
});

test('resize keyboard: ArrowUp raises manual height by 16 from min', async () => {
  dom();
  const { setupComposerExpand } = await import(moduleUrl());
  const box = document.querySelector('.input-box');
  const handle = box.querySelector('.composer-resize-handle');
  setupComposerExpand({ inputBoxEl: box, textareaEl: document.getElementById('user-input') });
  handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  // Manual height counts as custom height (AMC hasCustomHeight = expanded || manual),
  // but the corner button must NOT report expanded.
  assert.equal(document.getElementById('user-input').dataset.customHeight, 'true');
  assert.equal(box.querySelector('.composer-expand-btn').getAttribute('aria-pressed'), 'false');
  assert.match(box.querySelector('.composer-editor-frame').style.height, /42px/); // 26 + 16
  handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
  assert.match(box.querySelector('.composer-editor-frame').style.height, /26px/);
});

test('mouse drag on handle sets clamped manual height', async () => {
  dom();
  const { setupComposerExpand } = await import(moduleUrl());
  const box = document.querySelector('.input-box');
  const handle = box.querySelector('.composer-resize-handle');
  setupComposerExpand({ inputBoxEl: box, textareaEl: document.getElementById('user-input') });
  // Seed a known manual height via keyboard first (26+16=42), then drag up by 26 more.
  handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  handle.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientY: 200 }));
  document.dispatchEvent(new window.MouseEvent('mousemove', { clientY: 174 })); // +26 → 68px
  assert.match(box.querySelector('.composer-editor-frame').style.height, /68px/);
  document.dispatchEvent(new window.MouseEvent('mousemove', { clientY: 5000 })); // clamp to min
  assert.match(box.querySelector('.composer-editor-frame').style.height, /26px/);
  document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
});

test('double init is idempotent and missing DOM returns null', async () => {
  dom();
  const { setupComposerExpand } = await import(moduleUrl());
  const box = document.querySelector('.input-box');
  const a = setupComposerExpand({ inputBoxEl: box, textareaEl: document.getElementById('user-input') });
  const b = setupComposerExpand({ inputBoxEl: box, textareaEl: document.getElementById('user-input') });
  assert.ok(a); assert.equal(b, null);
  assert.equal(setupComposerExpand({ inputBoxEl: null, textareaEl: null }), null);
});
