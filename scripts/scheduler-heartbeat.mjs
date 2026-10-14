// A heartbeat proves the scheduler loop is alive; the last run separately
// proves due work executed. Idle minutes must neither fail nor erase failures.
export function nextHeartbeat(previous, { now = Date.now(), jobs, failures }) {
  return { checkedAt: now, jobs, failures,
    lastRun: jobs > 0 ? { at: now, jobs, failures } : previous?.lastRun ?? null };
}
export function heartbeatHealthy(data, now = Date.now()) {
  const age = now - data?.checkedAt;
  const run = data?.lastRun;
  const runAge = now - run?.at;
  return Number.isFinite(age) && age >= 0 && age <= 170000 &&
    Number.isFinite(runAge) && runAge >= 0 && runAge <= 370000 &&
    Number.isInteger(run?.jobs) && run.jobs > 0 && run.failures === 0;
}
