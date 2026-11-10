// Test helper: one separate wallet worker process (its own module graph and
// PostgreSQL pool), used to test competing workers, crashes and restarts.
// Usage: node scripts/helpers/wallet-worker.mjs '<json>'
//   {"action":"dispatch","payoutId":"wpo_…"} | {"action":"settle"} |
//   {"action":"request","input":{…requestWithdrawal input…}}
// Prints one JSON line with the result. A simulated provider crash exits 137.
import { configureSimulationEnv, startHarness } from "./server-harness.mjs";

const job = JSON.parse(process.argv[2] ?? "{}");
configureSimulationEnv({ DATABASE_URL: process.env.DATABASE_URL });
const harness = await startHarness();
let result;
try {
  const wallet = await harness.load("/src/modules/wallet/public/wallet.server.ts");
  if (job.startAt) await new Promise((r) => setTimeout(r, Math.max(0, job.startAt - Date.now())));
  if (job.action === "dispatch") result = await wallet.dispatchPayouts({ payoutId: job.payoutId });
  else if (job.action === "settle") result = await wallet.runWalletSettlement();
  else if (job.action === "request") result = await wallet.requestWithdrawal(job.input);
  else throw new Error(`unknown action ${job.action}`);
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) })}\n`);
} finally {
  await harness.close();
}
