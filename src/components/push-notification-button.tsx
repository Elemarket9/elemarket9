import { Bell, BellOff, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { createClientOnlyFn } from "@tanstack/react-start";
const enablePush = createClientOnlyFn(async () => {
  const provider = await import("@/modules/notifications/public/notifications/push/push.client");
  return provider.enablePush();
});

const STORAGE_KEY = "elemarket:push-enabled";

export function PushNotificationButton() {
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const available = typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator && window.isSecureContext;
    setSupported(available);
    try { setEnabled(available && Notification.permission === "granted" && localStorage.getItem(STORAGE_KEY) === "1"); } catch { setEnabled(false); }
  }, []);

  if (!supported) return null;

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await enablePush();
      try { localStorage.setItem(STORAGE_KEY, "1"); } catch { /* Registration remains valid when browser storage is blocked. */ }
      setEnabled(true);
    } catch {
      setError("Notifications could not be enabled. Check browser permissions and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
    <button
      type="button"
      onClick={onClick}
      disabled={busy || enabled}
      className="flex h-10 w-10 items-center justify-center rounded-xl border border-market-line bg-white hover:bg-market-soft disabled:cursor-default disabled:opacity-70"
      aria-label={enabled ? "Push notifications enabled" : "Enable push notifications"}
      title={enabled ? "Push notifications enabled" : "Enable push notifications"}
    >
      {busy ? <Loader2 size={18} className="animate-spin" /> : enabled ? <Bell size={18} /> : <BellOff size={18} />}
    </button>
    {error && <p role="alert" className="mt-1 max-w-56 text-xs text-red-700">{error}</p>}
    </div>
  );
}
