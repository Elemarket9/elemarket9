import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "elemarket.mobile.bearer.v1";
const BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "").replace(/\/+$/, "");

function assertSecureBaseUrl() {
  if (!BASE_URL) throw new Error("EXPO_PUBLIC_API_BASE_URL is required");
  const url = new URL(BASE_URL);
  const isLocalDev = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const allowLocalHttp = typeof __DEV__ !== "undefined" && __DEV__ && isLocalDev && url.protocol === "http:";
  if (url.protocol !== "https:" && !allowLocalHttp) {
    throw new Error("ELEMARKET mobile API must use HTTPS");
  }
  if (url.username || url.password) throw new Error("ELEMARKET mobile API URL must not contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("ELEMARKET mobile API URL must be an origin without a path, query or fragment");
  if (!isLocalDev && url.port && url.port !== "443") throw new Error("ELEMARKET mobile API must use HTTPS port 443");
  return url;
}

const API_ORIGIN = assertSecureBaseUrl().origin;
const REQUEST_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(input, { ...init, redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

export async function getToken() { return SecureStore.getItemAsync(TOKEN_KEY); }

export async function signIn(email: string, password: string) {
  const response = await fetchWithTimeout(`${API_ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email: email.trim().toLowerCase(), password, rememberMe: true }),
  });
  if (!response.ok) throw new Error("Invalid email or password");
  const token = response.headers.get("set-auth-token");
  if (!token || token.length < 32 || token.length > 512) throw new Error("Authentication token was not issued");
  await SecureStore.setItemAsync(TOKEN_KEY, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  return token;
}

export async function signOut() {
  const token = await getToken();
  if (token) {
    await fetchWithTimeout(`${API_ORIGIN}/api/auth/sign-out`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
  }
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid API path");
  const destination = new URL(path, API_ORIGIN);
  if (destination.origin !== API_ORIGIN) throw new Error("API requests must stay on the configured origin");
  const token = await getToken();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetchWithTimeout(destination, { ...init, headers });
  if (response.status === 401) await SecureStore.deleteItemAsync(TOKEN_KEY);
  return response;
}
