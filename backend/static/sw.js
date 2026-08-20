/* JustSearch Service Worker — 对齐 AMC VitePWA injectManifest 轻量版，缓存静态资源 */
const CACHE_NAME = 'justsearch-static-v1';
const PRECACHE_URLS = [
  '/',
  '/static/dist/css/style.css',
  '/static/fonts/fonts.css',
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(()=>{})));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => k !== CACHE_NAME && caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // 仅缓存同源 GET 静态资源，不拦截 API / WebSocket
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/justsearch')) return;
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((resp) => {
        if (resp.ok) caches.open(CACHE_NAME).then((c) => c.put(event.request, resp.clone())).catch(()=>{});
        return resp;
      }).catch(() => cached))
    );
  }
});
