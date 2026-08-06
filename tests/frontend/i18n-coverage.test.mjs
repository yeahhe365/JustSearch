import test from 'node:test';
import assert from 'node:assert/strict';
import { zh } from '../../backend/static/js/modules/locales/zh.js';
import { en } from '../../backend/static/js/modules/locales/en.js';

function keySet(dict) {
    return new Set(Object.keys(dict));
}

function paramTokens(str) {
    const tokens = new Set();
    String(str).replace(/\{(\w+)\}/g, (_, k) => tokens.add(k));
    return tokens;
}

test('zh and en have identical key sets', () => {
    const zhKeys = keySet(zh);
    const enKeys = keySet(en);

    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));

    assert.deepEqual(
        missingInEn,
        [],
        `Keys present in zh but missing in en:\n  ${missingInEn.join('\n  ')}`
    );
    assert.deepEqual(
        missingInZh,
        [],
        `Keys present in en but missing in zh:\n  ${missingInZh.join('\n  ')}`
    );
});

test('zh and en use the same {param} token sets per key', () => {
    const mismatches = [];
    for (const key of Object.keys(zh)) {
        const zhTokens = paramTokens(zh[key]);
        const enTokens = paramTokens(en[key]);
        if (zhTokens.size !== enTokens.size || [...zhTokens].some((t) => !enTokens.has(t))) {
            mismatches.push(`${key}: zh=[${[...zhTokens].join(',')}] en=[${[...enTokens].join(',')}]`);
        }
    }
    assert.deepEqual(mismatches, [], `Param token mismatch:\n  ${mismatches.join('\n  ')}`);
});

test('zh values are non-empty strings', () => {
    const empty = Object.entries(zh).filter(([k, v]) => !v).map(([k]) => k);
    assert.deepEqual(empty, [], `Empty zh values:\n  ${empty.join('\n  ')}`);
});
