const test = require("node:test");
const assert = require("node:assert/strict");
const { HOUR, refreshState, startRefreshScheduler } = require("../lib/refresh");

const now = Date.parse("2026-10-11T12:00:00Z");
const at = hours => new Date(now - hours * HOUR).toISOString();

test("new or overdue cities trigger catch-up even when another city is fresh", () => {
  const state = refreshState({ cities: ["SF", "Oakland", "Boston"], harvestedAt: at(1), cityHarvestedAt: { SF: at(1), Oakland: at(25), Boston: null } }, { now });
  assert.deepEqual(state.dueCities, ["Oakland", "Boston"]);
  assert.equal(state.stale, true);
  assert.equal(state.lastSuccessAt, null);
});

test("fresh cities do not get downloaded on every server start", () => {
  const state = refreshState({ cities: ["SF"], cityHarvestedAt: { SF: at(2) } }, { now });
  assert.deepEqual(state.dueCities, []);
  assert.equal(state.nextRefreshAt, new Date(now + 22 * HOUR).toISOString());
});

test("failed refreshes stay stale and back off rather than looping", () => {
  const state = refreshState({ cities: ["SF"], cityHarvestedAt: { SF: at(48) }, refresh: { lastAttemptAt: at(.25), lastError: "incomplete" } }, { now });
  assert.equal(state.stale, true);
  assert.deepEqual(state.dueCities, []);
  assert.equal(state.nextRefreshAt, new Date(now + .75 * HOUR).toISOString());
});

test("kill switch disables startup and timer harvests", () => {
  const state = refreshState({ cities: ["SF"] }, { now, disabled: true });
  assert.equal(state.enabled, false);
  assert.equal(state.nextRefreshAt, null);
  assert.deepEqual(state.dueCities, []);
});

test("timer catches overdue data but never overlaps a running harvest", async () => {
  let running = true, calls = 0;
  const stop = startRefreshScheduler({ tickMs: 5, getState: () => ({ dueCities: ["SF"] }), isRunning: () => running, run: () => { calls++; running = true; } });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(calls, 0);
  running = false;
  await new Promise(resolve => setTimeout(resolve, 20));
  stop();
  assert.equal(calls, 1);
});
