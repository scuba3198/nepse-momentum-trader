self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const staleCaches = (await caches.keys()).filter(cache =>
      cache.includes('nepse-momentum-trader') || cache === 'nepse-holidays'
    );
    await Promise.all(staleCaches.map(cache => caches.delete(cache)));
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      await client.navigate(client.url);
    }
  })());
});
