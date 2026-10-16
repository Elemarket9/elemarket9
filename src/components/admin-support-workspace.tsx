import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addSupportInternalNote,
  manageOrderDeliveryHold,
  getSupportThread,
  listSupportInbox,
  replySupportThread,
  updateSupportConversationState,
  type SupportInboxRow,
  type SupportPriority,
  type SupportThread,
} from "@/modules/support/public/admin-support.functions";

import { AssistedOrderComposer } from "./assisted-order-composer";
import { messageAttempt, type MessageAttempt } from "@/modules/support/public/message-attempt";
import { useCurrentUserState } from "@/modules/identity/public/auth/use-current-user";
import { withSupportRequestTimeout } from "@/modules/support/public/request-timeout";

export function AdminSupportWorkspace({ compact = false }: { compact?: boolean }) {
  const { user, isPending } = useCurrentUserState();
  const [sessionStalled, setSessionStalled] = useState(false);
  useEffect(() => {
    setSessionStalled(false);
    if (!isPending) return;
    const timer = window.setTimeout(() => setSessionStalled(true), 25_000);
    return () => window.clearTimeout(timer);
  }, [isPending]);
  // Avoid firing protected inbox requests before the browser has resolved its
  // session. An early 401 used to look like a permanently empty/stuck inbox.
  if (isPending) return <p role="status" className="rounded-2xl border border-market-line bg-white p-4 text-sm text-market-muted">{sessionStalled ? "The administrator session is taking too long to load." : "Opening support inbox…"}{sessionStalled ? <button type="button" className="ml-2 font-bold underline" onClick={() => window.location.reload()}>Reload</button> : null}</p>;
  if (!user) return <p role="alert" className="rounded-2xl border border-market-line bg-white p-4 text-sm text-market-muted">Sign in as an authorized administrator to view support.</p>;
  return <SupportWorkspace key={user?.id ?? "signed-out"} compact={compact} />;
}

function SupportWorkspace({ compact }: { compact: boolean }) {
  const [inbox, setInbox] = useState<SupportInboxRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadedThread, setThread] = useState<SupportThread | null>(null);
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [holdReason,setHoldReason]=useState("");
  const [busy, setBusy] = useState(false);
  const [inboxLoading, setInboxLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(false);
  const selection = useRef(selected);
  selection.current = selected;
  const inboxVersion = useRef(0);
  const threadVersion = useRef(0);
  const actionPending = useRef(false);
  const replyAttempt = useRef<MessageAttempt | null>(null);
  const noteAttempt = useRef<MessageAttempt | null>(null);
  const thread = loadedThread?.conversation.id === selected ? loadedThread : null;
  const canManage = Boolean(thread && (!thread.conversation.assignedAdminId || thread.conversation.assignedToMe));

  const refreshInbox = useCallback(async () => {
    const version = ++inboxVersion.current;
    try {
      const rows = await withSupportRequestTimeout(listSupportInbox());
      if (!mounted.current || version !== inboxVersion.current) return false;
      setInbox(rows);
      setSelected(current => current && rows.some(row => row.id === current) ? current : rows[0]?.id ?? null);
      setInboxLoading(false);
      return true;
    } catch {
      if (mounted.current && version === inboxVersion.current) {
        setInboxLoading(false);
        setError("Support inbox could not be refreshed.");
      }
      return false;
    }
  }, []);

  const refreshThread = useCallback(async (id: string) => {
    const version = ++threadVersion.current;
    try {
      const next = await withSupportRequestTimeout(getSupportThread({ data: { conversationId: id } }));
      if (!mounted.current || selection.current !== id || version !== threadVersion.current) return false;
      setThread(next);
      return true;
    } catch {
      if (mounted.current && selection.current === id && version === threadVersion.current) setError("Support conversation could not be loaded.");
      return false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let polling = false;
    const poll = async () => {
      if (polling || actionPending.current) return;
      polling = true;
      try { await refreshInbox(); } finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void poll(); }, 15_000);
    return () => { mounted.current = false; inboxVersion.current += 1; window.clearInterval(timer); };
  }, [refreshInbox]);

  useEffect(() => {
    setThread(null); setReply(""); setNote(""); setError(null);
    replyAttempt.current = null; noteAttempt.current = null;
    if (!selected) return;
    let polling = false;
    const poll = async () => {
      if (polling || actionPending.current) return;
      polling = true;
      try { await refreshThread(selected); } finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void poll(); }, 10_000);
    return () => { threadVersion.current += 1; window.clearInterval(timer); };
  }, [refreshThread, selected]);

  const waitingCount = useMemo(() => inbox.filter(row => row.status === "waiting_support" || row.status === "open").length, [inbox]);

  async function applyDeliveryHold(action:"hold"|"release") {
    if(!thread?.conversation.orderId || !canManage || holdReason.trim().length<12 || actionPending.current) return;
    actionPending.current=true;setBusy(true);setError(null);
    try{
      await withSupportRequestTimeout(manageOrderDeliveryHold({data:{orderId:thread.conversation.orderId,action,reason:holdReason.trim()}}));
      setHoldReason("");
      await refreshThread(thread.conversation.id);
    }catch{setError("Delivery hold update was not confirmed. Verify shipment status before retrying.")}
    finally{actionPending.current=false;setBusy(false)}
  }

  async function sendReply() {
    if (!thread || !canManage || thread.conversation.status === "closed" || !reply.trim() || actionPending.current) return;
    const id = thread.conversation.id;
    const attempt = messageAttempt(replyAttempt.current, id, reply);
    replyAttempt.current = attempt;
    actionPending.current = true; setBusy(true); setError(null);
    try {
      await withSupportRequestTimeout(replySupportThread({ data: attempt }));
      replyAttempt.current = null;
      if (!mounted.current || selection.current !== id) return;
      setReply("");
      const results = await Promise.all([refreshThread(id), refreshInbox()]);
      if (mounted.current && results.some(ok => !ok)) setError("Reply sent. The workspace could not refresh; it will retry automatically.");
    } catch { if (mounted.current) setError("Reply could not be confirmed. Retry to check or send it safely."); }
    finally { actionPending.current = false; if (mounted.current) setBusy(false); }
  }

  async function saveNote() {
    if (!thread || !note.trim() || actionPending.current) return;
    const id = thread.conversation.id;
    const attempt = messageAttempt(noteAttempt.current, id, note);
    noteAttempt.current = attempt;
    actionPending.current = true; setBusy(true); setError(null);
    try {
      await withSupportRequestTimeout(addSupportInternalNote({ data: attempt }));
      noteAttempt.current = null;
      if (!mounted.current || selection.current !== id) return;
      setNote("");
      if (!await refreshThread(id) && mounted.current) setError("Internal note saved. The conversation could not refresh.");
    } catch { if (mounted.current) setError("Internal note could not be confirmed. Retry to save it safely."); }
    finally { actionPending.current = false; if (mounted.current) setBusy(false); }
  }

  async function act(action: "claim" | "unclaim" | "resolve" | "reopen" | "close" | "set_priority", priority?: SupportPriority) {
    if (!thread || thread.conversation.status === "closed" || actionPending.current) return;
    const id = thread.conversation.id;
    actionPending.current = true; setBusy(true); setError(null);
    try {
      await withSupportRequestTimeout(updateSupportConversationState({ data: { conversationId: id, action, priority: priority ?? null } }));
      await Promise.all([refreshThread(id), refreshInbox()]);
    } catch { if (mounted.current) setError("Support state changed elsewhere or the action is not allowed."); }
    finally { actionPending.current = false; if (mounted.current) setBusy(false); }
  }

  return (
    <section className="rounded-2xl border border-market-line bg-white shadow-market" aria-label="Admin support workspace">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-market-line px-4 py-3">
        <div><h2 className="text-lg font-black">Customer Support</h2><p className="text-xs text-market-muted">{waitingCount} waiting for support · auto-refreshing</p></div>
        <a href="/admin/support" className="text-xs font-black text-market-green">Full support workspace</a>
      </div>
      {error ? <p role="alert" className="mx-4 mt-3 rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">{error}<button type="button" disabled={busy} onClick={() => { setError(null); void refreshInbox(); if (selected) void refreshThread(selected); }} className="ml-2 underline">Retry refresh</button></p> : null}
      <div className={`grid overflow-hidden ${compact ? "min-h-[460px] lg:grid-cols-[280px_1fr]" : "min-h-[650px] lg:grid-cols-[320px_1fr]"}`}>
        <aside className="max-h-[650px] overflow-y-auto border-b border-market-line lg:border-b-0 lg:border-r">
          {inboxLoading ? <p role="status" className="p-4 text-sm text-market-muted">Loading support conversations…</p> : inbox.length === 0 ? <p className="p-4 text-sm text-market-muted">No active support conversations.</p> : inbox.map((row) => (
            <button key={row.id} type="button" disabled={busy} onClick={() => setSelected(row.id)} className={`block w-full border-b border-market-line p-3 text-left hover:bg-market-soft ${selected === row.id ? "bg-market-soft" : ""}`}>
              <div className="flex items-center justify-between gap-2"><b className="truncate text-xs">{row.customerName || row.customerEmail || "Customer"}</b><span className={`rounded-full px-2 py-0.5 text-[9px] font-black ${row.priority === "urgent" ? "bg-red-100 text-red-700" : row.priority === "high" ? "bg-amber-100 text-amber-800" : "bg-market-soft text-market-muted"}`}>{row.priority}</span></div>
              <p className="mt-1 truncate text-[11px] text-market-muted">{row.orderId ? `Order ${row.orderId}` : "General support"} · {row.status.replaceAll("_", " ")}</p>
              <p className="mt-1 truncate text-[10px] font-semibold text-market-muted">{row.assignedToMe ? "Assigned to you" : row.assignedAdminName ? `Assigned to ${row.assignedAdminName}` : "Unassigned"} · {new Date(row.updatedAt).toLocaleString()}</p>
              <p className="mt-1 truncate text-[11px] text-market-muted">{row.lastMessage || "No messages yet"}</p>
            </button>
          ))}
        </aside>
        <div className="flex min-w-0 flex-col">
          {!thread ? <div className="grid flex-1 place-items-center p-6 text-sm text-market-muted">Select a conversation.</div> : <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-market-line p-3">
              <div className="min-w-0"><p className="truncate text-xs font-black">{thread.conversation.customerName || thread.conversation.customerEmail || thread.conversation.customerId}</p><p className="text-[10px] text-market-muted">{thread.conversation.orderId ? `Order ${thread.conversation.orderId} · ` : ""}{thread.conversation.status.replaceAll("_", " ")} · {thread.conversation.assignedToMe ? "assigned to you" : thread.conversation.assignedAdminName ? `assigned to ${thread.conversation.assignedAdminName}` : "unassigned"}</p></div>
              <div className="flex flex-wrap gap-1.5">
                <select aria-label="Support priority" value={thread.conversation.priority} disabled={busy} onChange={(event) => void act("set_priority", event.target.value as SupportPriority)} className="rounded-lg border border-market-line px-2 py-1.5 text-[10px] font-bold">
                  <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
                </select>
                {!thread.conversation.assignedAdminId ? <button disabled={busy} onClick={() => void act("claim")} className="rounded-lg border px-2 py-1.5 text-[10px] font-black">Claim</button> : thread.conversation.assignedToMe ? <button disabled={busy} onClick={() => void act("unclaim")} className="rounded-lg border px-2 py-1.5 text-[10px] font-black">Unclaim</button> : null}
                {thread.conversation.status === "resolved" ? <button disabled={busy || !canManage} onClick={() => void act("reopen")} className="rounded-lg bg-market-green px-2 py-1.5 text-[10px] font-black text-white">Reopen</button> : <button disabled={busy || !canManage || thread.conversation.status === "closed"} onClick={() => void act("resolve")} className="rounded-lg bg-market-green px-2 py-1.5 text-[10px] font-black text-white">Resolve</button>}
                <button disabled={busy || !canManage || thread.conversation.status === "closed"} onClick={() => { if (window.confirm("Close this support conversation? Closed conversations are terminal.")) void act("close"); }} className="rounded-lg border border-red-200 px-2 py-1.5 text-[10px] font-black text-red-700">Close</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto bg-market-bg/50 p-3">
              <div className="space-y-2">{thread.messages.map((message) => <div key={message.id} className={`max-w-[85%] rounded-2xl px-3 py-2 whitespace-pre-wrap break-words text-xs leading-5 [overflow-wrap:anywhere] ${message.senderType === "support" ? "ml-auto bg-market-green text-white" : "bg-white shadow-sm"}`}>{message.body}</div>)}</div>
              {thread.notes.length > 0 ? <div className="mt-4 border-t border-dashed border-amber-300 pt-3"><p className="mb-2 text-[10px] font-black uppercase tracking-wider text-amber-800">Internal notes — never customer visible</p>{thread.notes.map((item) => <div key={item.id} className="mb-2 rounded-xl bg-amber-50 p-2.5 text-[11px] text-amber-950"><b>{item.adminName || "Admin"}</b> · {new Date(item.createdAt).toLocaleString()}<p className="mt-1 whitespace-pre-wrap">{item.body}</p></div>)}</div> : null}
            </div>
            {thread.conversation.orderId ? <div className="border-t border-market-line bg-amber-50 p-3"><p className="text-xs font-black">Parcel hold — authorized support only</p><p className="text-[11px] text-market-muted">Verify the caller independently. A hold pauses handover, NOT changes the locked order address or number. Release only after investigation.</p><input value={holdReason} onChange={e=>setHoldReason(e.target.value)} maxLength={1000} placeholder="Reason (min. 12 characters)" className="my-2 w-full rounded-lg border p-2 text-xs"/><div className="flex flex-wrap gap-2"><button type="button" disabled={busy||!canManage||holdReason.trim().length<12} onClick={()=>void applyDeliveryHold("hold")} className="rounded-lg bg-amber-800 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">Place shipment on hold</button><button type="button" disabled={busy||!canManage||holdReason.trim().length<12} onClick={()=>void applyDeliveryHold("release")} className="rounded-lg border border-red-400 px-3 py-2 text-xs font-bold text-red-800 disabled:opacity-50">Release hold (verified)</button></div></div>:null}
            <AssistedOrderComposer key={thread.conversation.id} conversationId={thread.conversation.id} disabled={busy || !canManage || thread.conversation.status === "closed"} />
            <div className="grid gap-2 border-t border-market-line p-3 sm:grid-cols-2">
              <div><textarea aria-label="Reply to customer" disabled={busy || !canManage || thread.conversation.status === "closed"} value={reply} onChange={(event) => setReply(event.target.value.slice(0, 4000))} rows={2} maxLength={4000} placeholder="Reply to customer…" className="w-full resize-none rounded-xl border border-market-line p-2.5 text-xs outline-none focus:border-market-green"/><button disabled={busy || !canManage || !reply.trim() || thread.conversation.status === "closed"} onClick={() => void sendReply()} className="mt-1.5 rounded-lg bg-market-orange px-3 py-2 text-[10px] font-black text-white disabled:opacity-40">Send reply</button></div>
              <div><textarea aria-label="Internal support note" disabled={busy} value={note} onChange={(event) => setNote(event.target.value.slice(0, 4000))} rows={2} maxLength={4000} placeholder="Internal note (customer cannot see)…" className="w-full resize-none rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-xs outline-none focus:border-amber-400"/><button disabled={busy || !note.trim()} onClick={() => void saveNote()} className="mt-1.5 rounded-lg border border-amber-300 px-3 py-2 text-[10px] font-black text-amber-900 disabled:opacity-40">Save internal note</button></div>
            </div>
          </>}
        </div>
      </div>
    </section>
  );
}
