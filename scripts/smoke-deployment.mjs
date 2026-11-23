#!/usr/bin/env node
// Post-deployment smoke test. Run it against any ELEMARKET deployment, from
// outside, through the public proxy, after every deploy:
//
//   ELEMARKET_DOMAIN=elemarket.com.gh ELEMARKET_SELLER_HOST=seller.… ELEMARKET_STAFF_HOST=… \
//   ELEMARKET_EXECUTIVE_HOST=… ELEMARKET_PROVIDER_HOST=… node scripts/smoke-deployment.mjs
//
// Optional: CRON_SECRET (proves the scheduler credential works end to end),
// NODE_EXTRA_CA_CERTS (a private/test CA). Read-only: it creates nothing and
// sends no money, SMS or email. Exit code 1 if any check fails.
import http from "node:http";

const env = (k) => process.env[k]?.trim();
const hosts = {
  marketplace: env("ELEMARKET_DOMAIN"),
  seller: env("ELEMARKET_SELLER_HOST"),
  staff: env("ELEMARKET_STAFF_HOST"),
  executive: env("ELEMARKET_EXECUTIVE_HOST"),
  provider: env("ELEMARKET_PROVIDER_HOST"),
};
for (const [name, host] of Object.entries(hosts)) if (!host) { console.error(`missing host for ${name}`); process.exit(2); }

const results = [];
const check = (name, pass, detail = "") => { results.push({ name, pass: Boolean(pass), detail }); };
const warn = (name, detail) => { results.push({ name, pass: true, warn: true, detail }); };
async function get(host, path, init = {}) {
  const res = await fetch(`https://${host}${path}`, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init });
  const body = init.method === "HEAD" ? "" : await res.text();
  return { status: res.status, headers: res.headers, body };
}
function plainHttp(host, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, path, port: 80, timeout: 10_000 }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location }); });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
const blocked = async (host, path) => {
  const r = await get(host, path);
  check(`${host}${path} is blocked at the edge`, r.status === 404, `HTTP ${r.status}`);
};

async function run() {
  const m = hosts.marketplace;
  // Health and TLS
  const health = await get(m, "/api/health");
  let healthBody = null; try { healthBody = JSON.parse(health.body); } catch { /* not JSON */ }
  check("health endpoint reports ok with database", health.status === 200 && healthBody?.ok === true && healthBody?.checks?.database === "ok",
    `HTTP ${health.status} ${JSON.stringify(healthBody?.checks ?? {})}`);
  check("health endpoint is not cached", /no-store/.test(health.headers.get("cache-control") ?? ""), health.headers.get("cache-control") ?? "none");
  const redirect = await plainHttp(m, "/").catch((e) => ({ error: e.message }));
  check("plain HTTP redirects to HTTPS", [301, 302, 307, 308].includes(redirect.status) && /^https:\/\//.test(redirect.location ?? ""),
    redirect.error ?? `${redirect.status} -> ${redirect.location}`);

  // Storefront
  const home = await get(m, "/");
  check("storefront renders", home.status === 200 && /<html/i.test(home.body), `HTTP ${home.status}`);
  const h = home.headers;
  check("HSTS header", /max-age=\d{6,}/.test(h.get("strict-transport-security") ?? ""), h.get("strict-transport-security") ?? "missing");
  check("nosniff header", h.get("x-content-type-options") === "nosniff", h.get("x-content-type-options") ?? "missing");
  check("framing is restricted", /frame-ancestors/.test(h.get("content-security-policy") ?? "") || /deny|sameorigin/i.test(h.get("x-frame-options") ?? ""),
    (h.get("content-security-policy") ?? h.get("x-frame-options") ?? "missing").slice(0, 80));
  check("referrer policy set", Boolean(h.get("referrer-policy")), h.get("referrer-policy") ?? "missing");
  check("server version not disclosed", !/\d/.test(h.get("server") ?? "") && !h.get("x-powered-by"), `${h.get("server") ?? ""} ${h.get("x-powered-by") ?? ""}`.trim() || "none");
  for (const p of ["/admin", "/admin/", "/merchant", "/merchant/login", "/provider/", "/api/executive/session"]) await blocked(m, p);

  // Each portal lands on its own entrance and refuses the others
  const landing = [[hosts.seller, "/merchant/login"], [hosts.staff, "/admin/"], [hosts.executive, "/admin/"], [hosts.provider, "/provider/"]];
  for (const [host, target] of landing) {
    const r = await get(host, "/");
    check(`${host}/ goes to ${target}`, r.status === 302 && (r.headers.get("location") ?? "").endsWith(target), `${r.status} -> ${r.headers.get("location")}`);
    const page = await get(host, target);
    check(`${host}${target} is served`, page.status === 200 || (page.status >= 300 && page.status < 400), `HTTP ${page.status}`);
  }
  for (const p of ["/admin/", "/provider/"]) await blocked(hosts.seller, p);
  for (const p of ["/merchant/login", "/provider/", "/manifest.webmanifest"]) await blocked(hosts.staff, p);
  for (const p of ["/merchant/login", "/provider/"]) await blocked(hosts.executive, p);
  for (const p of ["/admin/", "/merchant/login"]) await blocked(hosts.provider, p);
  const staffPage = await get(hosts.staff, "/admin/");
  check("admin portal is not cached", /no-store/.test(staffPage.headers.get("cache-control") ?? ""), staffPage.headers.get("cache-control") ?? "none");

  // Scheduled jobs require the scheduler credential
  const job = "/api/internal/wallet-settlement";
  const anon = await get(m, job);
  check("scheduled job refuses anonymous calls", anon.status === 401, `HTTP ${anon.status}`);
  const wrong = await get(m, job, { headers: { authorization: "Bearer not-the-secret-not-the-secret-0000" } });
  check("scheduled job refuses a wrong credential", wrong.status === 401, `HTTP ${wrong.status}`);
  if (env("CRON_SECRET")) {
    const ok = await get(m, job, { headers: { authorization: `Bearer ${env("CRON_SECRET")}` } });
    check("scheduled job accepts the scheduler credential", ok.status === 200, `HTTP ${ok.status}`);
  }

  // Webhooks refuse unsigned input without crashing
  for (const p of ["/api/payments/webhook", "/api/payouts/webhook"]) {
    const r = await get(m, p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "charge.success", data: { reference: "smoke" } }) });
    if (p === "/api/payments/webhook" && r.status === 503) {
      // No payment provider is active yet: the endpoint asks the sender to retry later. Correct before
      // go-live, but on a live store it means payments cannot be confirmed.
      warn(`${p} has no active payment provider`, "HTTP 503; activate a provider before taking real orders");
      continue;
    }
    check(`${p} refuses unsigned input`, r.status >= 400 && r.status < 500, `HTTP ${r.status}`);
  }
}

try { await run(); }
catch (error) { check("smoke test completed", false, error.message); }
const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.warn ? "WARN" : r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
