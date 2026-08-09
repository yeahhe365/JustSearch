import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildAuthenticatedUrl,
    buildAuthHeaders,
    clearAuthRetryFlag,
    handleUnauthorizedResponse,
    initializeAuth,
    normalizeSettings,
    resolveClientAuth,
} from '../../backend/static/js/modules/auth.js';

test('resolveClientAuth prefers token from query string and strips it from url', () => {
    const result = resolveClientAuth({
        bootstrapToken: '',
        storedToken: 'stored-token',
        url: 'http://example.com/c/demo?token=query-token&foo=bar#hash',
    });

    assert.equal(result.token, 'query-token');
    assert.equal(result.shouldPersist, true);
    assert.equal(result.cleanedPath, '/c/demo?foo=bar#hash');
});

test('buildAuthHeaders adds bearer token when available', () => {
    assert.deepEqual(buildAuthHeaders('secret-token'), {
        Authorization: 'Bearer secret-token',
    });
    assert.deepEqual(buildAuthHeaders(''), {});
});

test('buildAuthenticatedUrl appends token when available', () => {
    assert.equal(
        buildAuthenticatedUrl('/api/history/export/all?format=markdown', 'secret-token'),
        '/api/history/export/all?format=markdown&token=secret-token',
    );
    assert.equal(buildAuthenticatedUrl('/api/history/export/all', ''), '/api/history/export/all');
});

test('api path helper encodes ids before route interpolation', async () => {
    globalThis.document = {
        addEventListener: () => {},
    };
    globalThis.window = {
        markdownit: () => ({
            render: value => String(value || ''),
            utils: { escapeHtml: value => String(value || '') },
        }),
        DOMPurify: { sanitize: value => String(value || '') },
        hljs: { getLanguage: () => false, highlightAuto: value => ({ value }) },
    };

    const { __apiTestHooks } = await import('../../backend/static/js/modules/api.js?test=path-encoding');

    assert.equal(__apiTestHooks.encodePathSegment('id?x=1#frag'), 'id%3Fx%3D1%23frag');
});

test('api error helper reads JSON details and plain text bodies', async () => {
    globalThis.document = {
        addEventListener: () => {},
    };
    globalThis.window = {
        markdownit: () => ({
            render: value => String(value || ''),
            utils: { escapeHtml: value => String(value || '') },
        }),
        DOMPurify: { sanitize: value => String(value || '') },
        hljs: { getLanguage: () => false, highlightAuto: value => ({ value }) },
    };

    const { __apiTestHooks } = await import('../../backend/static/js/modules/api.js?test=error-helper');

    assert.equal(
        await __apiTestHooks.getResponseErrorMessage(
            new Response(JSON.stringify({ detail: { reason: 'bad config' } }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            }),
            'fallback',
        ),
        '{"reason":"bad config"}',
    );
    assert.equal(
        await __apiTestHooks.getResponseErrorMessage(
            new Response('gateway unavailable', { status: 502 }),
            'fallback',
        ),
        'gateway unavailable',
    );
    assert.equal(
        await __apiTestHooks.getResponseErrorMessage(
            new Response('', { status: 504 }),
            'fallback',
        ),
        'fallback',
    );
});

test('normalizeSettings turns nullish values into an empty object', () => {
    assert.deepEqual(normalizeSettings(null), {});
    assert.deepEqual(normalizeSettings(undefined), {});
    assert.deepEqual(normalizeSettings({ model_id: 'demo-model' }), {
        model_id: 'demo-model',
    });
});

test('handleUnauthorizedResponse clears stale token and reloads once', () => {
    const local = new Map([['justsearch_auth_token', 'stale-token']]);
    const session = new Map();
    let reloads = 0;
    const win = {
        localStorage: {
            removeItem: (key) => local.delete(key),
        },
        sessionStorage: {
            getItem: (key) => session.get(key) || '',
            setItem: (key, value) => session.set(key, value),
            removeItem: (key) => session.delete(key),
        },
        location: {
            reload: () => { reloads += 1; },
        },
    };

    assert.equal(handleUnauthorizedResponse({ status: 401 }, win), true);
    assert.equal(local.has('justsearch_auth_token'), false);
    assert.equal(session.get('justsearch_auth_retry'), '1');
    assert.equal(reloads, 1);

    assert.equal(handleUnauthorizedResponse({ status: 401 }, win), false);
    assert.equal(reloads, 1);

    clearAuthRetryFlag(win);
    assert.equal(session.has('justsearch_auth_retry'), false);
});
