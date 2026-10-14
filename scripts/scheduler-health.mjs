#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { heartbeatHealthy } from './scheduler-heartbeat.mjs';
const path = process.env.ELEMARKET_SCHEDULER_HEARTBEAT || '/tmp/elemarket-scheduler-heartbeat.json';
try {
  const data = JSON.parse(await readFile(path,'utf8'));
  if (!heartbeatHealthy(data)) process.exit(1);
  console.log('scheduler heartbeat healthy');
} catch { process.exit(1); }
