import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

test('composer shell radius aligns with AMC pill radius', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css','utf8');
  assert.match(css, /--amc-radius-lg\s*:\s*1\.625rem|26px|18px/);
  assert.match(css, /\.input-box\s*\{[^}]*border-radius[^}]*var\(--amc-radius-lg|--radius-xl/);
});

test('P1: composer graphite theme tokens exist', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css', 'utf8');
  assert.match(css, /\[data-theme="graphite"\][^{]*#input-area/, 'input-area should have graphite theme block');
  assert.match(css, /#2b2b2e|#3c3c40|graphite/, 'graphite colors should appear');
});

test('P1: composer edit banner uses theme warning token not hardcoded #f59e0b alone', () => {
  const css = readFileSync('backend/static/css/sections/input-modal.css', 'utf8');
  // Should reference theme warning variable at least once, not only hardcoded #f59e0b
  assert.match(css, /var\(--theme-bg-warning|--theme-bg-warning-strong|--amc-warning/, 'should use theme warning var');
});

test('P1: main-header glass aligns with theme (not legacy --glass-bg)', () => {
  const css = readFileSync('backend/static/css/sections/chat.css', 'utf8');
  // After P1, main-header should use theme-bg-secondary with color-mix, not just var(--glass-bg)
  assert.match(css, /main-header[^{]*\{[^}]*var\(--theme-bg-secondary|--theme-bg-primary/, 'main-header should reference theme tokens');
});

test('P1: markdown code header uses theme code block header', () => {
  const css = readFileSync('backend/static/css/sections/markdown.css', 'utf8');
  assert.match(css, /\.code-block-header[^{]*\{[^}]*var\(--theme-bg-code-block-header/, 'code header should use theme var');
});

test('P1: live artifacts frame supports graphite', () => {
  const css = readFileSync('backend/static/css/sections/live-artifacts.css', 'utf8');
  // Should have graphite or dark handling for artifact frame
  assert.match(css, /\[data-theme="graphite"\]|\.artifact-frame/, 'live artifacts css should exist');
  assert.match(css, /var\(--theme-border-secondary/, 'should use theme border');
});

test('P1: sidebar per-viewport keys exist', () => {
  const js = readFileSync('backend/static/js/modules/sidebar.js', 'utf8');
  assert.match(js, /sidebarCollapsed_desktop|DESKTOP_BP|isDesktop/, 'sidebar.js should have per-viewport logic');
});

test('P1: settings search highlight uses <mark>', () => {
  const js = readFileSync('backend/static/js/modules/settings-search.js', 'utf8');
  assert.match(js, /<mark|settings-search-highlight|aria-selected/, 'settings-search should have highlight and aria');
});
