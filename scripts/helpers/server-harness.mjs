// Test harness: real server modules on an isolated in-memory PGlite (every
// migration applied) with an in-process mock of the payment provider API.
// No request leaves the machine. Used by the *.integration.mjs simulations.
import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createPaymentFixture } from "./payment-fixture.mjs";
import { quoteCartCanonical } from "../../src/lib/commerce-guards.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PAYMENT_SECRET = `sk_test_simulated_${"x".repeat(32)}`;

export function configureSimulationEnv(extra = {}) {
  Object.assign(process.env, {
    ELEMARKET_ENV: "development",
    ELEMARKET_PAYMENT_ALLOWED_MODULES: "builtin:paystack",
    ELEMARKET_PAYMENT_DRIVER_PAYSTACK_MODULE: "builtin:paystack",
    ELEMARKET_PAYMENT_PAYSTACK_DRIVER: "paystack",
    ELEMARKET_PAYMENT_PAYSTACK_SECRET: PAYMENT_SECRET,
    ELEMARKET_PAYMENT_PAYSTACK_CHECKOUT_HOSTS: "checkout.paystack.com",
    BETTER_AUTH_URL: "https://marketplace.example.com",
    ...extra,
  });
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
}

/** Mock of the provider's initialize/verify API. ledger: reference -> charge. */
export function installPaymentProviderMock() {
  const ledger = new Map();
  const initializeBodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== "api.paystack.co") return realFetch(url, init);
    const json = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (init.headers?.authorization !== `Bearer ${PAYMENT_SECRET}`) return json(401, { status: false });
    if (u.pathname === "/transaction/initialize") {
      const b = JSON.parse(init.body);
      initializeBodies.push(b);
      if (!ledger.has(b.reference)) ledger.set(b.reference, { amount: Number(b.amount), currency: b.currency, status: "abandoned" });
      return json(200, { status: true, data: { reference: b.reference, authorization_url: `https://checkout.paystack.com/${b.reference.slice(0, 12)}`, access_code: "ac_sim" } });
    }
    const m = u.pathname.match(/^\/transaction\/verify\/(.+)$/);
    if (m) {
      const ref = decodeURIComponent(m[1]);
      const t = ledger.get(ref);
      if (!t) return json(404, { status: false });
      return json(200, { status: true, data: { status: t.status, reference: ref, amount: t.amount, currency: t.currency } });
    }
    return json(404, { status: false });
  };
  return {
    ledger,
    initializeBodies,
    pay: (ref, ok = true) => { ledger.get(ref).status = ok ? "success" : "failed"; },
    sign: (raw) => createHmac("sha512", PAYMENT_SECRET).update(raw).digest("hex"),
    restore: () => { globalThis.fetch = realFetch; },
  };
}

export async function startHarness() {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false },
    resolve: {
      alias: [
        { find: "@tanstack/react-start/server", replacement: path.join(root, "scripts/helpers/start-request-stub.mjs") },
        { find: "@", replacement: path.join(root, "src") },
      ],
    },
    ssr: { external: ["@electric-sql/pglite", "pg"] },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const load = (p) => vite.ssrLoadModule(p);
  const { getSql } = await load("/src/lib/db.ts");
  const sql = await getSql();
  await sql.query(
    `insert into payment_providers(id, provider_key, name, method, status, driver_key)
     values('pp_paystack','paystack','Paystack (simulated)','mobile_money','active','paystack')
     on conflict (provider_key) do update set status='active', driver_key='paystack'`,
  );
  return { vite, sql, load, close: () => vite.close() };
}

/** Seed a verified customer, active merchant and one pending fixture order. */
export async function seedOrder(sql) {
  const ids = await createPaymentFixture((q, params) => sql.query(q, params));
  await sql.query(`update payment_providers set status='inactive' where provider_key=$1`, [ids.provider]);
  await sql.query(`update payments set provider_key='paystack' where id=$1`, [ids.payment]);
  await sql.query(
    `insert into merchant_payment_accounts(id, merchant_id, provider_key, provider_account_ref, status, verified_at)
     values($1, $2, 'paystack', $3, 'active', now()) on conflict do nothing`,
    [`mpa_${ids.merchant}`, ids.merchant, `ACCT_sim_${ids.merchant.slice(-8)}`],
  );
  return ids;
}

/** Real create_pending_order() for one unit of the seed product. */
export async function checkout(sql, seed, { promoCode = null, address = "1 Test Street" } = {}) {
  const tag = Math.random().toString(36).slice(2, 10);
  const items = [{ productId: seed.product, variantId: seed.variant, quantity: 1 }];
  const fingerprint = createHash("sha256")
    .update(quoteCartCanonical({ merchantId: seed.merchant, address, tier: "same_day", items }))
    .digest("hex");
  const quoteId = `${seed.quote}_${tag}`;
  await sql.query(
    `insert into delivery_quotes(id,user_id,merchant_id,fingerprint,tier,price,eta_minutes,distance_km,dest_address,expires_at)
     values($1,$2,$3,$4,'same_day',15,60,1,$5,now()+interval '1 hour')`,
    [quoteId, seed.user, seed.merchant, fingerprint, address],
  );
  const [{ result }] = await sql.query(
    `with identity as (select set_config('app.user_id',$1,true) u)
     select create_pending_order($1,$2,$3,$4::jsonb,$5::jsonb,$6,'mobile_money',$7) as result from identity`,
    [seed.user, `${seed.idem}_${tag}_0123`, createHash("sha256").update(tag).digest("hex"), JSON.stringify(items),
      JSON.stringify([{ merchantId: seed.merchant, quoteId }]), address, promoCode],
  );
  return result.orders[0];
}
