import assert from 'node:assert';
import { test } from 'node:test';

// Use JSDOM minimal for SVG creation
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html>');
global.document = dom.window.document;

import { createSettingsTabIcon, createActionIcon } from '../../backend/static/js/modules/settings-icons.js';

test('createSettingsTabIcon general returns Settings gear SVG', () => {
  const el = createSettingsTabIcon('general');
  assert.equal(el.tagName.toLowerCase(), 'svg');
  assert.equal(el.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(el.getAttribute('fill'), 'none');
  assert.equal(el.getAttribute('stroke'), 'currentColor');
  assert.ok(el.innerHTML.includes('M12.22') || el.innerHTML.includes('circle'));
});

test('createSettingsTabIcon bridge returns IconMcp (not extension)', () => {
  const el = createSettingsTabIcon('bridge');
  assert.equal(el.tagName.toLowerCase(), 'svg');
  assert.ok(el.innerHTML.includes('M15.688'));
});

test('createSettingsTabIcon system returns IconData', () => {
  const el = createSettingsTabIcon('system');
  assert.ok(el.innerHTML.includes('ellipse'));
});

test('createSettingsTabIcon about returns IconAbout', () => {
  const el = createSettingsTabIcon('about');
  assert.ok(el.innerHTML.includes('circle'));
});

test('createActionIcon delete returns Trash2 path', () => {
  const el = createActionIcon('delete', 16);
  assert.equal(el.getAttribute('width'), '16');
  assert.equal(el.getAttribute('height'), '16');
  assert.equal(el.getAttribute('aria-hidden'), 'true');
});

test('createActionIcon expand_more and expand_less differ', () => {
  const a = createActionIcon('expand_more', 16);
  const b = createActionIcon('expand_less', 16);
  assert.notEqual(a.innerHTML, b.innerHTML);
});
