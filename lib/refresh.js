"use strict";

const HOUR = 60 * 60 * 1000;

/** Per-city freshness prevents a small, successful harvest from hiding stale cities. */
function refreshState(db, { now = Date.now(), intervalMs = 24 * HOUR, retryMs = HOUR, disabled = false } = {}) {
  const cities = db.cities || [];
  const times = cities.map(city => Date.parse(db.cityHarvestedAt && Object.hasOwn(db.cityHarvestedAt, city) ? db.cityHarvestedAt[city] : db.harvestedAt) || 0);
  const oldest = times.length ? Math.min(...times) : 0;
  const lastAttempt = Date.parse(db.refresh?.lastAttemptAt) || 0;
  const nextAt = Math.max(oldest ? oldest + intervalMs : now, lastAttempt ? lastAttempt + retryMs : 0);
  return {
    enabled: !disabled,
    intervalHours: intervalMs / HOUR,
    lastSuccessAt: oldest ? new Date(oldest).toISOString() : null,
    lastAttemptAt: db.refresh?.lastAttemptAt || null,
    lastCompletedAt: db.refresh?.lastCompletedAt || null,
    lastError: db.refresh?.lastError || null,
    nextRefreshAt: disabled || !cities.length ? null : new Date(nextAt).toISOString(),
    stale: !oldest || now - oldest >= intervalMs,
    dueCities: disabled || now < nextAt ? [] : cities.filter((city, i) => !times[i] || now - times[i] >= intervalMs),
  };
}

/** Uses wall-clock checks so resume from sleep catches up; overlapping jobs share one harvest. */
function startRefreshScheduler({ getState, run, isRunning, onError = console.error, tickMs = 60000 }) {
  const check = () => {
    if (isRunning()) return;
    const state = getState();
    if (state.dueCities.length) Promise.resolve(run(state.dueCities)).catch(onError);
  };
  const timer = setInterval(check, tickMs);
  timer.unref();
  check();
  return () => clearInterval(timer);
}

module.exports = { HOUR, refreshState, startRefreshScheduler };
