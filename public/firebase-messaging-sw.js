/* ELEMARKET FCM service worker. Firebase web config is public client configuration, not a secret. */
globalThis.importScripts("https://www.gstatic.com/firebasejs/12.5.0/firebase-app-compat.js");
globalThis.importScripts("https://www.gstatic.com/firebasejs/12.5.0/firebase-messaging-compat.js");

function decodeConfig(encoded) {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((encoded.length + 3) % 4);
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

const encoded = new URL(self.location.href).searchParams.get("config");
if (!encoded) throw new Error("Missing Firebase configuration");

const firebase = globalThis.firebase;
if (!firebase) throw new Error("Firebase SDK failed to load");

firebase.initializeApp(decodeConfig(encoded));
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const notification = payload.notification || {};
  const title = notification.title || "ELEMARKET";
  const options = {
    body: notification.body || "You have a new update.",
    icon: "/favicon.svg",
    data: payload.data || {},
  };
  self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const candidate = event.notification?.data?.url;
  let target = "/";
  try {
    const parsed = new URL(candidate || "/", self.location.origin);
    if (parsed.origin === self.location.origin && (parsed.protocol === "https:" || parsed.protocol === "http:")) target = parsed.pathname + parsed.search + parsed.hash;
  } catch { target = "/"; }
  event.waitUntil(globalThis.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) {
      if ("focus" in client) {
        client.navigate(target);
        return client.focus();
      }
    }
    return globalThis.clients.openWindow(target);
  }));
});
