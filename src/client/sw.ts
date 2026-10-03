// This classic worker is compiled with DOM types; its small event contracts avoid mixing DOM and WebWorker globals.
interface WorkerLifecycleEvent extends Event { waitUntil(promise: Promise<unknown>): void }
interface WorkerFetchEvent extends WorkerLifecycleEvent { request: Request; respondWith(response: Promise<Response>): void }
interface WorkerPushEvent extends WorkerLifecycleEvent { data: { json(): unknown } | null }
interface WorkerNotificationEvent extends WorkerLifecycleEvent { notification: { close(): void; data: unknown } }
interface AppWindowClient { url: string; focus(): Promise<unknown>; navigate(url: string): Promise<unknown> }
interface AppWorkerScope {
  addEventListener(type: string, listener: (event: never) => void): void;
  skipWaiting(): Promise<void>;
  location: Location;
  registration: { showNotification(title: string, options: NotificationOptions): Promise<void> };
  clients: { claim(): Promise<void>; matchAll(options: { type: string; includeUncontrolled: boolean }): Promise<AppWindowClient[]>; openWindow(url: string): Promise<unknown> };
}
const worker = globalThis as unknown as AppWorkerScope;
const shellCache = 'gauge-shell-v1';
const shellFiles = ['/', '/index.html', '/styles.css', '/manifest.webmanifest', '/js/app.js', '/js/i18n.js', '/locales/en.json', '/locales/zh-TW.json', '/locales/ja.json', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-192.png', '/icons/maskable-512.png'];
worker.addEventListener('install', (event: WorkerLifecycleEvent) => {
  event.waitUntil(caches.open(shellCache).then(cache => cache.addAll(shellFiles)).then(() => worker.skipWaiting()));
});
worker.addEventListener('activate', (event: WorkerLifecycleEvent) => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('gauge-shell-') && key !== shellCache).map(key => caches.delete(key)))).then(() => worker.clients.claim()));
});
worker.addEventListener('fetch', (event: WorkerFetchEvent) => {
  const url = new URL(event.request.url);
  // Never cache API responses, authorization headers, callbacks, or third-party requests.
  if (event.request.method !== 'GET' || url.origin !== worker.location.origin || url.search || !shellFiles.includes(url.pathname)) return;
  const refresh = fetch(event.request).then(async response => {
    if (response.ok && response.type === 'basic') { const cache = await caches.open(shellCache); await cache.put(url.pathname, response.clone()); }
    return response;
  });
  event.waitUntil(refresh.catch(() => undefined));
  event.respondWith(caches.match(url.pathname).then(cached => cached ?? refresh));
});
worker.addEventListener('push', (event: WorkerPushEvent) => {
  event.waitUntil((async () => {
    let payload: unknown;
    try { payload = event.data?.json(); } catch { return; }
    if (!payload || typeof payload !== 'object' || !('title' in payload) || typeof payload.title !== 'string') return;
    const body = 'body' in payload && typeof payload.body === 'string' ? payload.body : '';
    const tag = 'tag' in payload && typeof payload.tag === 'string' ? payload.tag : undefined;
    let destination = '/';
    if ('url' in payload && typeof payload.url === 'string') {
      try { const url = new URL(payload.url, worker.location.origin); if (url.origin === worker.location.origin && url.pathname === '/') destination = url.pathname; } catch { /* Keep the dashboard as the only destination. */ }
    }
    await worker.registration.showNotification(payload.title, { body, tag, icon: '/icons/icon-192.png', badge: '/icons/maskable-192.png', data: { url: destination } });
  })());
});
worker.addEventListener('notificationclick', (event: WorkerNotificationEvent) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      const url = new URL(client.url);
      if (url.origin === worker.location.origin && url.pathname === '/') { await client.focus(); return; }
    }
    await worker.clients.openWindow('/');
  })());
});
