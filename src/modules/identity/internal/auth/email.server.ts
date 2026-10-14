import { createHash } from "node:crypto";
import { getEmailAdapter } from "./email/registry.server";

type AuthEmailKind = "verification" | "password_reset";

type AuthEmailInput = {
  kind: AuthEmailKind;
  to: string;
  name: string;
  url: string;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
}

function idempotencyKey(input: AuthEmailInput): string {
  const digest = createHash("sha256")
    .update(`${input.kind}\n${input.to.trim().toLowerCase()}\n${input.url}`)
    .digest("hex");
  return `auth/${input.kind}/${digest}`;
}

/** All authentication email is routed through the same provider-neutral email boundary as OTP. */
export async function sendAuthEmail(input: AuthEmailInput): Promise<void> {
  const adapter = getEmailAdapter();
  const safeName = escapeHtml(input.name);
  const safeUrl = escapeHtml(input.url);
  const subject = input.kind === "password_reset" ? "Reset your ELEMARKET password" : "Verify your ELEMARKET email";
  const text = input.kind === "password_reset"
    ? `Hello ${input.name}, use this link to reset your ELEMARKET password: ${input.url}`
    : `Hello ${input.name}, verify your ELEMARKET email: ${input.url}`;
  const html = input.kind === "password_reset"
    ? `<div style="font-family:Arial,sans-serif;line-height:1.5;max-width:560px;margin:auto"><h2>Reset your ELEMARKET password</h2><p>Hello ${safeName},</p><p><a href="${safeUrl}">Reset your password</a></p><p>This link expires according to your account recovery policy.</p></div>`
    : `<div style="font-family:Arial,sans-serif;line-height:1.5;max-width:560px;margin:auto"><h2>Verify your ELEMARKET email</h2><p>Hello ${safeName},</p><p><a href="${safeUrl}">Verify your email address</a></p></div>`;
  const result = await adapter.send({
    to: input.to, subject, text, html, kind: input.kind, idempotencyKey: idempotencyKey(input),
  });
  if (!result.accepted) throw new Error("Authentication email was not accepted by the provider");
}
