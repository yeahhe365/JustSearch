const STORAGE_KEY = 'justsearch_auth_token';
const AUTH_RETRY_KEY = 'justsearch_auth_retry';

let authState = {
    token: '',
    authEnabled: false,
    clientIsLoopback: false,
};

export function normalizeSettings(settings) {
    return settings && typeof settings === 'object' ? settings : {};
}

export function resolveClientAuth({ bootstrapToken = '', storedToken = '', url }) {
    const parsed = new URL(url, 'http://localhost');
    const queryToken = (parsed.searchParams.get('token') || '').trim();

    parsed.searchParams.delete('token');
    const cleanedQuery = parsed.searchParams.toString();
    const cleanedPath = `${parsed.pathname}${cleanedQuery ? `?${cleanedQuery}` : ''}${parsed.hash || ''}`;

    return {
        token: queryToken || bootstrapToken || storedToken || '',
        shouldPersist: Boolean(queryToken),
        cleanedPath,
    };
}

export function buildAuthHeaders(token, headers = {}) {
    const merged = {};
    for (const [key, value] of new Headers(headers || {}).entries()) {
        merged[key] = value;
    }
    if (token) {
        delete merged.authorization;
        merged.Authorization = `Bearer ${token}`;
    }
    return merged;
}

export function buildAuthenticatedUrl(path, token = getAuthToken()) {
    // Deprecated: token in URL leaks via Referer/history. Prefer authFetch with Bearer header.
    // 仅保留给 localhost 回退测试路径使用；生产环境应使用 authFetch
    if (!token) {
        return path;
    }
    const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const url = new URL(path, baseOrigin);
    url.searchParams.set('token', token);
    return `${url.pathname}${url.search}${url.hash}`;
}

export function initializeAuth(win = window) {
    const bootstrap = win.__JUSTSEARCH_BOOTSTRAP__ || {};
    const storedToken = (() => {
        try {
            return win.localStorage.getItem(STORAGE_KEY) || '';
        } catch (e) {
            return '';
        }
    })();

    const resolved = resolveClientAuth({
        bootstrapToken: bootstrap.authToken || '',
        storedToken,
        url: win.location.href,
    });

    if (resolved.token) {
        try {
            win.localStorage.setItem(STORAGE_KEY, resolved.token);
        } catch (e) {
            // Ignore storage errors and continue using in-memory token.
        }
    }

    const currentPath = `${win.location.pathname}${win.location.search}${win.location.hash}`;
    if (resolved.cleanedPath !== currentPath && win.history?.replaceState) {
        win.history.replaceState(win.history.state, '', resolved.cleanedPath);
    }

    authState = {
        token: resolved.token,
        authEnabled: Boolean(bootstrap.authEnabled),
        clientIsLoopback: Boolean(bootstrap.clientIsLoopback),
    };

    return authState;
}

export function getAuthToken() {
    return authState.token;
}

export function clearAuthRetryFlag(win = globalThis.window) {
    try {
        win?.sessionStorage?.removeItem(AUTH_RETRY_KEY);
    } catch (e) {
        // Ignore storage errors.
    }
}

export function clearStoredAuthToken(win = globalThis.window) {
    authState = { ...authState, token: '' };
    try {
        win?.localStorage?.removeItem(STORAGE_KEY);
    } catch (e) {
        // Ignore storage errors.
    }
}

export function handleUnauthorizedResponse(response, win = globalThis.window) {
    if (!response || response.status !== 401) {
        return false;
    }

    clearStoredAuthToken(win);

    let shouldReload = true;
    try {
        if (win?.sessionStorage?.getItem(AUTH_RETRY_KEY) === '1') {
            shouldReload = false;
        } else {
            win?.sessionStorage?.setItem(AUTH_RETRY_KEY, '1');
        }
    } catch (e) {
        // Reload without the loop guard if sessionStorage is unavailable.
    }

    if (!shouldReload || !win?.location?.reload) {
        return false;
    }

    win.location.reload();
    return true;
}

export async function authFetch(input, init = {}) {
    const headers = buildAuthHeaders(getAuthToken(), init.headers);
    const response = await fetch(input, { ...init, headers });
    if (response.status === 401) {
        handleUnauthorizedResponse(response);
    } else {
        clearAuthRetryFlag();
    }
    return response;
}
