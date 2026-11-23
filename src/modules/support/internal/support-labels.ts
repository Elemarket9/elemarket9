type SupportStatus = "open" | "waiting_customer" | "waiting_support" | "resolved" | "closed";

export function supportStatusLabel(status: SupportStatus | undefined): string {
  if (status === "waiting_support") return "We have your message. An agent will reply here.";
  if (status === "waiting_customer") return "ELEMARKET replied. Waiting for you.";
  if (status === "resolved") return "Resolved. Reply to reopen.";
  if (status === "closed") return "Closed";
  return "We usually reply within minutes";
}


/** How long the customer has been waiting for a reply. Amber after 15 minutes, red after an hour. */
export function waitingLabel(since: string, now = Date.now()): { text: string; tone: "ok" | "warn" | "late" } {
  const minutes = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000));
  const text = minutes < 1 ? "Waiting just now" : minutes < 60 ? `Waiting ${minutes} min` : minutes < 1440 ? `Waiting ${Math.floor(minutes / 60)}h ${minutes % 60}m` : `Waiting ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  return { text, tone: minutes >= 60 ? "late" : minutes >= 15 ? "warn" : "ok" };
}

