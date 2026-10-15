#!/usr/bin/env node
/** Single-instance portable scheduler for approved internal GET jobs.
 * Put it behind the private Docker network; never expose its signed secrets.
 */
import { writeFile } from 'node:fs/promises';
import { JOBS, dueJobs } from './scheduler-core.mjs';
import { nextHeartbeat } from './scheduler-heartbeat.mjs';
import { runScheduledJob } from './scheduler-request.mjs';
const baseUrl = process.env.ELEMARKET_SCHEDULER_BASE_URL || 'http://app:8080';
const cronSecret = process.env.CRON_SECRET?.trim();
if (!cronSecret || cronSecret.length < 32) throw new Error('CRON_SECRET >= 32 characters required');
const base = new URL(baseUrl);
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/')
  throw new Error('Invalid scheduler base URL');
// Private app network only by default; public remote targets require separate audited deployment.
if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('Unexpected protocol');
const enabledJobs = JOBS;
const heartbeatPath = process.env.ELEMARKET_SCHEDULER_HEARTBEAT || '/tmp/elemarket-scheduler-heartbeat.json';
let lastMinute = -1;
let heartbeat = null;
let executing = false;
let stopping = false;
const abortController = new AbortController();
async function runOne(job) {
  await runScheduledJob({ base, path: job.path, secret: cronSecret, signal: abortController.signal });
}
async function tick() {
  const minute = Math.floor(Date.now() / 60000);
  if (minute === lastMinute || executing || stopping) return;
  if (lastMinute >= 0 && minute > lastMinute + 1) {
    console.error(`[scheduler] missed ${minute - lastMinute - 1} minute(s); investigate capacity. No backlog replay.`);
  }
  lastMinute = minute;
  executing = true;
  const jobs = dueJobs(minute);
  let failures = 0;
  try {
    await Promise.all(jobs.map(async (job) => {
      try { await runOne(job); console.log(`[scheduler] job ok: ${job.path}`); }
      catch (error) { failures++; console.error(`[scheduler] job failed: ${job.path}:`, error?.message ?? error); }
    }));
    // Missed/failed tasks remain observable; health check goes unhealthy when
    // there is a failure, rather than silently declaring the scheduler healthy.
    heartbeat = nextHeartbeat(heartbeat, { jobs: jobs.length, failures });
    await writeFile(heartbeatPath, JSON.stringify(heartbeat));
  } finally { executing=false; }
}
process.on('SIGINT',()=>{stopping=true;abortController.abort();});
process.on('SIGTERM',()=>{stopping=true;abortController.abort();});
console.log(`[scheduler] started for ${enabledJobs.length} jobs at ${base.origin}`);
// Run on the NEXT aligned minute boundary. Do not fire backfilled jobs on boot.
const delay = 60000 - (Date.now() % 60000);
setTimeout(()=>{
  if (stopping) return;
  void tick().catch((err)=>console.error('[scheduler] tick failed',err));
  setInterval(()=>{
    if (stopping) return process.exit(0);
    void tick().catch((err)=>console.error('[scheduler] tick failed',err));
  },10000);
},delay);
