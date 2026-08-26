/**
 * utils: shared escapeRegExp / highlightText used by settings-search and
 * shortcuts-help. highlightText must match on RAW text and escape each
 * segment afterwards — the old per-module copies regex-replaced already
 * escaped text, corrupting output when text or query contained & < > " '.
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

function utilsModuleUrl() {
    return pathToFileURL(path.join(root, 'backend/static/js/modules/utils.js')).href + `?t=${Date.now()}`;
}

test('highlightText wraps plain matches with a settings-search-highlight mark', async () => {
    const { highlightText } = await import(utilsModuleUrl());
    assert.equal(
        highlightText('Hello world', 'world'),
        'Hello <mark class="settings-search-highlight">world</mark>',
    );
});

test('highlightText is case-insensitive and keeps original casing', async () => {
    const { highlightText } = await import(utilsModuleUrl());
    assert.equal(
        highlightText('Foo foo FOO', 'foo'),
        '<mark class="settings-search-highlight">Foo</mark> '
        + '<mark class="settings-search-highlight">foo</mark> '
        + '<mark class="settings-search-highlight">FOO</mark>',
    );
});

test('highlightText escapes HTML specials in both text and matched query', async () => {
    const { highlightText } = await import(utilsModuleUrl());
    // Every literal '&' in the text matches and is escaped inside its mark;
    // surrounding text is still escaped, never double-processed.
    assert.equal(
        highlightText('AT&T & Sons', '&'),
        'AT<mark class="settings-search-highlight">&amp;</mark>T '
        + '<mark class="settings-search-highlight">&amp;</mark> Sons',
    );
    // Quotes/angle brackets in surrounding text must not survive raw.
    assert.equal(
        highlightText('<b>"quoted"</b>', 'quoted'),
        '&lt;b&gt;&quot;<mark class="settings-search-highlight">quoted</mark>&quot;&lt;/b&gt;',
    );
});

test('highlightText with no match returns escaped text without marks', async () => {
    const { highlightText } = await import(utilsModuleUrl());
    assert.equal(highlightText('<b>abc</b>', 'zzz'), '&lt;b&gt;abc&lt;/b&gt;');
});

test('highlightText treats an empty query as plain escaping', async () => {
    const { highlightText, escapeRegExp } = await import(utilsModuleUrl());
    assert.equal(highlightText('a&b', ''), 'a&amp;b');
});

test('escapeRegExp escapes regex metacharacters', async () => {
    const { escapeRegExp } = await import(utilsModuleUrl());
    assert.equal(escapeRegExp('a.b*c?(d)[e]{f}|g^$h\\i'), 'a\\.b\\*c\\?\\(d\\)\\[e\\]\\{f\\}\\|g\\^\\$h\\\\i');
    const re = new RegExp(escapeRegExp('(x)'));
    assert.ok(re.test('(x)'), 'escaped pattern matches literally');
});
