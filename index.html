// VoxBridge Service Worker — handles push notifications

self.addEventListener('push', function(event) {
  if (!event.data) return;

  let data;
  try { data = event.data.json(); } catch(e) { return; }

  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: '/icon-96.png',
    tag: data.tag || 'voxbridge',
    renotify: data.renotify || false,
    requireInteraction: data.requireInteraction || false,
    vibrate: data.type === 'call' ? [200, 100, 200, 100, 200] : [200],
    data: data.data || { url: '/' },
    actions: data.type === 'call'
      ? [
          { action: 'open', title: '📞 Open App' },
          { action: 'dismiss', title: 'Dismiss' }
        ]
      : [
          { action: 'open', title: '💬 Open' }
        ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'VoxBridge', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // If app is already open, focus it
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf(self.location.origin) === 0 && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});

// Keep service worker active
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});
