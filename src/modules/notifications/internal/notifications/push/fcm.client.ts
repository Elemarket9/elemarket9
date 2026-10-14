import { registerPushToken, unregisterPushToken } from "@/modules/notifications/internal/transport/push.functions";

type FirebaseConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
};

type FirebaseCompat = {
  initializeApp: (config: FirebaseConfig) => unknown;
  apps: unknown[];
  messaging: () => {
    getToken: (options: { vapidKey: string; serviceWorkerRegistration: ServiceWorkerRegistration }) => Promise<string>;
    deleteToken: () => Promise<boolean>;
  };
};

declare global {
  interface Window {
    firebase?: FirebaseCompat;
  }
}

const SDK_VERSION = "12.5.0";
const SDK_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;
let sdkPromise: Promise<FirebaseCompat> | undefined;

function config(): FirebaseConfig {
  const values: FirebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "",
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "",
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "",
    appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "",
  };
  if (Object.values(values).some((value) => !value)) {
    throw new Error("Firebase web push is not configured");
  }
  return values;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
      } else {
        existing.addEventListener("load", () => resolve(), { once: true });
      }
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => { script.dataset.loaded = "true"; resolve(); };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function loadFirebase(): Promise<FirebaseCompat> {
  if (typeof window === "undefined") throw new Error("Push notifications require a browser");
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    await loadScript(`${SDK_BASE}/firebase-app-compat.js`);
    await loadScript(`${SDK_BASE}/firebase-messaging-compat.js`);
    if (!window.firebase) throw new Error("Firebase SDK did not initialize");
    if (!window.firebase.apps.length) window.firebase.initializeApp(config());
    return window.firebase;
  })();
  return sdkPromise;
}

function encodeConfigForWorker(value: FirebaseConfig): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) throw new Error("This browser does not support service workers");
  const encoded = encodeConfigForWorker(config());
  return navigator.serviceWorker.register(`/firebase-messaging-sw.js?config=${encoded}`, { scope: "/push/" });
}

export async function enableFcmPush(): Promise<{ registered: boolean }> {
  if (typeof window === "undefined" || !("Notification" in window)) throw new Error("Browser notifications are not supported");
  if (!window.isSecureContext) throw new Error("Push notifications require HTTPS");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted");

  const registration = await serviceWorkerRegistration();
  const firebase = await loadFirebase();
  const messaging = firebase.messaging();
  const vapidKey = String(import.meta.env.VITE_FIREBASE_VAPID_KEY ?? "").trim();
  if (!vapidKey) throw new Error("VITE_FIREBASE_VAPID_KEY is not configured");

  const token = await messaging.getToken({ vapidKey, serviceWorkerRegistration: registration });
  if (!token) throw new Error("FCM did not return a device token");

  await registerPushToken({
    data: {
      token,
      platform: "web",
      appVersion: import.meta.env.VITE_APP_VERSION ?? undefined,
    },
  });
  return { registered: true };
}

export async function disableFcmPush(): Promise<{ unregistered: boolean }> {
  const firebase = await loadFirebase();
  const messaging = firebase.messaging();
  let token: string | undefined;
  try {
    const registration = await serviceWorkerRegistration();
    token = await messaging.getToken({
      vapidKey: String(import.meta.env.VITE_FIREBASE_VAPID_KEY ?? ""),
      serviceWorkerRegistration: registration,
    });
  } catch {
    // The server-side record is best-effort cleaned when the browser no longer exposes a token.
  }
  if (token) await unregisterPushToken({ data: { token } });
  try { await messaging.deleteToken(); } catch { /* local token cleanup is best effort */ }
  return { unregistered: true };
}
