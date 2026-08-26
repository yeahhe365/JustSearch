/**
 * FIX 7 [P3] — extension/manifest.json
 *
 * 代码依赖 scripting.executeScript 的 injectImmediately 选项(Chrome ≥102,
 * 见 lib/runtime-messaging.js 与 handlers.js 的 Defuddle 注入),manifest 必须
 * 声明 minimum_chrome_version 以免旧版 Chrome 静默注入失败。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(__dirname, '../../extension/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

test('manifest pins minimum_chrome_version to 102', () => {
  assert.equal(String(manifest.minimum_chrome_version), '102');
});

test('permissions required by the Chrome-102 rationale stay present', () => {
  for (const perm of ['scripting', 'debugger', 'tabGroups', 'storage']) {
    assert.ok(manifest.permissions.includes(perm), `permission "${perm}" expected`);
  }
});
