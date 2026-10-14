#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
const path = process.env.ELEMARKET_SCHEDULER_HEARTBEAT || '/tmp/elemarket-scheduler-heartbeat.json';
try {
  const data = JSON.parse(await readFile(path,'utf8'));
  if (!Number.isFinite(data.checkedAt) || Date.now()-data.checkedAt>170000 || data.failures !== 0 || data.jobs < 1) process.exit(1);
  console.log('scheduler heartbeat healthy');
} catch { process.exit(1); }
