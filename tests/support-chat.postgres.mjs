// Support chat reliability on REAL PostgreSQL (migration 0239).
// The chat had no tests before this file.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { configureSimulationEnv, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
let db, harness, sql;
const agent = `sup_agent_${randomBytes(4).toString("hex")}`;
const key = () => `idem_${randomBytes(12).toString("hex")}`;

before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  configureSimulationEnv({ DATABASE_URL: db.url });
  harness = await startHarness();
  sql = harness.sql;
  await sql.query(`insert into "user"(id,name,email,"emailVerified",role) values($1,'Agent',$2,true,'admin')`, [agent, `${agent}@example.test`]);
});
after(async () => {
  if (!enabled) return;
  await harness?.close();
  await db?.drop();
});

const as = (user, text, params) => sql.query(`with identity as (select set_config('app.user_id',$1,true)) ${text} from identity`, [user, ...params]);
const open = async (user) => (await as(user, `select create_support_conversation($1,null) as id`, []))[0].id;
const customerSays = (user, conversation, body, k = key()) => as(user, `select append_customer_support_message($1,$2,$3,$4) as r`, [conversation, body, k]);
const agentSays = (conversation, body) => as(agent, `select append_support_agent_message($1,$2,$3,$4) as r`, [conversation, body, key()]);
const conv = async (id) => (await sql.query(`select status, waiting_since, customer_last_read_at from support_conversations where id=$1`, [id]))[0];
const unread = async (user) => (await sql.query(`select support_unread_count($1) as n`, [user]))[0].n;

test("waiting time starts at the customer's first unanswered message and stops when an agent replies", { skip }, async () => {
  const { user } = await seedOrder(sql);
  const id = await open(user);
  assert.equal((await conv(id)).waiting_since, null, "nothing to answer yet");
  await customerSays(user, id, "My parcel has not arrived");
  const first = (await conv(id)).waiting_since;
  assert.ok(first);
  await customerSays(user, id, "Hello? Anyone there?");
  assert.deepEqual((await conv(id)).waiting_since, first, "a follow-up does not reset the clock");
  await agentSays(id, "Sorry for the wait. Checking with the rider now.");
  assert.equal((await conv(id)).waiting_since, null);
  await customerSays(user, id, "Thank you");
  assert.ok((await conv(id)).waiting_since > first, "a new question starts a new wait");
});

test("a retried message with the same key is stored once", { skip }, async () => {
  const { user } = await seedOrder(sql);
  const id = await open(user);
  const k = key();
  await customerSays(user, id, "Was I charged twice?", k);
  await customerSays(user, id, "Was I charged twice?", k);
  const rows = await sql.query(`select 1 from support_messages where conversation_id=$1`, [id]);
  assert.equal(rows.length, 1);
});

test("unread badge: counts agent replies until the customer opens the thread", { skip }, async () => {
  const { user } = await seedOrder(sql);
  const other = (await seedOrder(sql)).user;
  const id = await open(user);
  await customerSays(user, id, "Can I change my delivery address?");
  assert.equal(await unread(user), 0, "own messages are never unread");
  await agentSays(id, "Yes, before it ships. What is the new address?");
  await agentSays(id, "Please also confirm your phone number.");
  assert.equal(await unread(user), 2);
  assert.equal(await unread(other), 0, "another customer sees nothing");
  await assert.rejects(as(other, `select mark_support_conversation_read($1,$2)`, [id]).then(async () => {
    assert.equal(await unread(user), 2, "someone else cannot clear my badge");
    throw new Error("still unread");
  }), /still unread/);
  await assert.rejects(sql.query(`select mark_support_conversation_read($1,$2)`, [user, id]), /unauthorized/);
  await as(user, `select mark_support_conversation_read($1,$2)`, [id]);
  assert.equal(await unread(user), 0);
  await agentSays(id, "Any update?");
  assert.equal(await unread(user), 1, "a later reply is unread again");
});

test("the agent inbox puts the longest-waiting customer first, urgent ahead of normal", { skip }, async () => {
  const source = (await import("node:fs")).readFileSync("src/modules/support/internal/admin-support.functions.ts", "utf8");
  const orderBy = source.match(/order by \(c\.waiting_since is null\)[^`]*/)?.[0];
  assert.ok(orderBy, "inbox sorts by waiting time");
  const mk = async (minutesAgo, priority) => {
    const { user } = await seedOrder(sql);
    const id = await open(user);
    await customerSays(user, id, `Waiting ${minutesAgo} minutes`);
    await sql.query(`update support_conversations set waiting_since=now()-($2||' minutes')::interval, priority=$3 where id=$1`, [id, String(minutesAgo), priority]);
    return id;
  };
  const answered = await mk(500, "normal");
  await agentSays(answered, "Answered already");
  const short = await mk(5, "normal");
  const long = await mk(120, "normal");
  const urgent = await mk(2, "urgent");
  const rows = await sql.query(`select c.id from support_conversations c where c.id = any($1::text[]) ${orderBy}`, [[answered, short, long, urgent]]);
  assert.deepEqual(rows.map((r) => r.id), [urgent, long, short, answered]);
});
