import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadTypeScript } from '../scripts/helpers/load-typescript.mjs';

const { waitingLabel, supportStatusLabel } = loadTypeScript('src/modules/support/internal/support-labels.ts');

test('agent inbox wait label turns amber at 15 minutes and red at an hour', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  assert.deepEqual(waitingLabel(ago(0), now), { text: 'Waiting just now', tone: 'ok' });
  assert.deepEqual(waitingLabel(ago(14), now), { text: 'Waiting 14 min', tone: 'ok' });
  assert.deepEqual(waitingLabel(ago(15), now), { text: 'Waiting 15 min', tone: 'warn' });
  assert.deepEqual(waitingLabel(ago(135), now), { text: 'Waiting 2h 15m', tone: 'late' });
  assert.deepEqual(waitingLabel(ago(1500), now), { text: 'Waiting 1d 1h', tone: 'late' });
});

test('customers are told plainly what is happening in every state', () => {
  assert.match(supportStatusLabel('waiting_support'), /We have your message/);
  assert.match(supportStatusLabel('waiting_customer'), /replied/);
  assert.match(supportStatusLabel('resolved'), /Reply to reopen/);
  assert.equal(supportStatusLabel('closed'), 'Closed');
});

test('one conversation UI: the widget and the /support page share the same components', () => {
  for (const file of ['src/components/contact-support-widget.tsx', 'src/routes/support.tsx']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /<SupportMessages/, file);
    assert.match(source, /<SupportComposer/, file);
    assert.doesNotMatch(source, /text-\[(9|10|11)px\]/, `${file}: no tiny text`);
  }
});

test('a failed message keeps its idempotency key for the retry and is never dropped', () => {
  const hook = fs.readFileSync('src/modules/support/internal/use-customer-support-chat.ts', 'utf8');
  assert.match(hook, /messageAttempt\(pendingAttempt\.current, conversationId, text\)/);
  assert.match(hook, /setOutgoing\(\{ body: attempt\.body, state: "failed" \}\)/);
  assert.match(hook, /if \(outgoing\) return;/, 'one unconfirmed message at a time');
});

test('the chat is mounted once for the whole site, so "Open support chat" works on every page', () => {
  const root = fs.readFileSync('src/routes/__root.tsx', 'utf8');
  assert.match(root, /<GlobalSupportWidget \/>/);
  const perPage = fs.readdirSync('src/routes', { recursive: true })
    .filter((f) => String(f).endsWith('.tsx'))
    .filter((f) => /<ContactSupportWidget/.test(fs.readFileSync(`src/routes/${f}`, 'utf8')));
  assert.deepEqual(perPage, [], 'pages must not mount their own copy');
});

test('the closed chat is a small icon, and the open chat can be minimised', () => {
  const widget = fs.readFileSync('src/components/contact-support-widget.tsx', 'utf8');
  assert.match(widget, /grid h-12 w-12 place-items-center rounded-full/);
  assert.match(widget, /aria-label="Minimise support chat"/);
  assert.doesNotMatch(widget, /fixed inset-0/, 'the open chat must not cover the whole marketplace');
});
