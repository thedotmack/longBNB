const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCriteria, normalizeCriteria, findMatches, createAssistant } = require("../lib/assistant");

const now = Date.parse("2026-10-11T12:00:00Z");
const cities = ["San-Francisco--CA", "Oakland--CA", "Daly-City--CA"];
const listing = (id, monthly, extra = {}) => ({ id, monthly, city: cities[0], type: "Room", runwayStart: "2026-10-01", runwayDays: 90, ...extra });

test("plain language extracts city, shorthand budget, room and duration", () => {
  const criteria = normalizeCriteria(parseCriteria("A room in SF under $1.5k for 2 months", cities, now), cities, now);
  assert.deepEqual(criteria, { location: "San Francisco, CA", cities: [cities[0]], maxMonthly: 1500, minDays: 60, moveIn: "2026-10-11", type: "Room" });
});

test("unsupported locations never silently fall back to every city", () => {
  const criteria = normalizeCriteria(parseCriteria("I want to live in Boston under $2000", cities, now), cities, now);
  assert.equal(criteria.location, "Boston");
  assert.deepEqual(criteria.cities, []);
  assert.deepEqual(findMatches([listing("1", 1000)], criteria, now), []);
});

test("budget is a strict ceiling, results are cheapest first, and past runway days are removed", () => {
  const criteria = normalizeCriteria({ maxMonthly: 1500, minDays: 60 }, cities, now);
  const matches = findMatches([listing("expensive", 1501), listing("boundary", 1500), listing("cheap", 999), listing("expired", 800, { runwayDays: 20 })], criteria, now);
  assert.deepEqual(matches.map(x => x.id), ["cheap", "boundary"]);
  assert.equal(matches[0].availableFrom, "2026-10-11");
  assert.equal(matches[0].availableDays, 80);
  assert.equal(matches[0].url, "https://www.airbnb.com/rooms/cheap");
});

test("date, city and room type must all match", () => {
  const criteria = normalizeCriteria({ location: "Oakland", type: "Whole Home", moveIn: "2026-11-01", minDays: 30 }, cities, now);
  const listings = [listing("wrong-city", 1000, { type: "Whole Home" }), listing("room", 1000, { city: cities[1] }), listing("home", 1200, { city: cities[1], type: "Whole Home" })];
  assert.deepEqual(findMatches(listings, criteria, now).map(x => x.id), ["home"]);
});

test("bad budgets, dates, and stay lengths are rejected", () => {
  for (const input of [{ maxMonthly: -1 }, { maxMonthly: NaN }, { minDays: 0 }, { minDays: 2.5 }, { moveIn: "2026-02-30" }, { moveIn: "tomorrow" }]) {
    assert.throws(() => normalizeCriteria(input, cities, now));
  }
});

test("without a key the finder makes no external requests", async () => {
  const helper = createAssistant({ fetchImpl: () => { throw new Error("must not call"); }, now: () => now });
  const result = await helper.interpret("Oakland, budget 2000", cities);
  assert.equal(result.mode, "local");
  assert.equal(result.criteria.maxMonthly, 2000);
});

test("AI is free-only, bounded, cached, and cannot override an explicit budget", async () => {
  let calls = 0;
  const helper = createAssistant({ apiKey: "test-only", now: () => now, fetchImpl: async (url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    assert.equal(request.model, "openrouter/free");
    assert.equal(request.max_tokens, 350);
    assert.equal(request.models, undefined);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ location: "Oakland", maxMonthly: 5000, minDays: 28, moveIn: "2026-10-11" }) } }] });
  } });
  const first = await helper.interpret("A room in SF under $1500", cities);
  assert.equal(first.mode, "ai");
  assert.equal(first.criteria.maxMonthly, 1500);
  assert.equal(first.criteria.location, "San Francisco, CA");
  await helper.interpret("A room in SF under $1500", cities);
  assert.equal(calls, 1);
});

test("unavailable or invalid AI responds through local search without another model call", async () => {
  for (const response of [new Response("busy", { status: 429 }), Response.json({ choices: [{ message: { content: "{}" } }] }), Response.json({ choices: [{ message: { content: "not json" } }] })]) {
    let calls = 0;
    const helper = createAssistant({ apiKey: "test-only", now: () => now, fetchImpl: async () => { calls++; return response; } });
    assert.equal((await helper.interpret("SF under $2000", cities)).mode, "local");
    await helper.interpret("SF under $2100", cities);
    assert.equal(calls, 1);
  }
});

test("daily free quota never changes to a paid model", async () => {
  let calls = 0;
  const helper = createAssistant({ apiKey: "test-only", now: () => now, dailyLimit: 1, fetchImpl: async () => { calls++; return Response.json({ choices: [{ message: { content: '{"location":"SF"}' } }] }); } });
  await helper.interpret("SF under $2000", cities);
  assert.equal((await helper.interpret("SF under $2100", cities)).mode, "local");
  assert.equal(calls, 1);
});

test("simultaneous identical searches share one call and preserve a supplied date", async () => {
  let calls = 0;
  const helper = createAssistant({ apiKey: "test-only", now: () => now, fetchImpl: async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return Response.json({ choices: [{ message: { content: '{"location":"SF","moveIn":"2026-12-01"}' } }] });
  } });
  const results = await Promise.all([helper.interpret("SF from 2026-11-01", cities), helper.interpret("SF from 2026-11-01", cities)]);
  assert.equal(calls, 1);
  assert.equal(results[0].criteria.moveIn, "2026-11-01");
  assert.equal(results[1].criteria.moveIn, "2026-11-01");
});

test("browser credentials have separate caches and quotas, with no paid fallback", async () => {
  const calls = [];
  const helper = createAssistant({ now: () => now, dailyLimit: 1, fetchImpl: async (url, options) => {
    calls.push(options.headers.Authorization);
    assert.equal(JSON.parse(options.body).model, "openrouter/free");
    return Response.json({ choices: [{ message: { content: '{"location":"SF"}' } }] });
  } });
  const same = await Promise.all([helper.interpret("a cheap place", cities, "browser-one"), helper.interpret("a cheap place", cities, "browser-one")]);
  assert.ok(same.every(result => result.mode === "ai"));
  assert.equal((await helper.interpret("a cheap place", cities, "browser-two")).mode, "ai");
  assert.equal((await helper.interpret("another place", cities, "browser-one")).mode, "local");
  assert.deepEqual(calls, ["Bearer browser-one", "Bearer browser-two"]);
});

test("a configured server key always overrides a supplied browser key", async () => {
  const helper = createAssistant({ apiKey: "server-key", now: () => now, fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer server-key");
    return Response.json({ choices: [{ message: { content: '{"location":"SF"}' } }] });
  } });
  assert.equal((await helper.interpret("a cheap place", cities, "browser-key")).mode, "ai");
});

test("credential state is bounded and expires at the next UTC day", async () => {
  let time = now;
  const helper = createAssistant({ now: () => time, maxKeys: 1, fetchImpl: async () => Response.json({ choices: [{ message: { content: '{"location":"SF"}' } }] }) });
  assert.equal((await helper.interpret("a cheap place", cities, "one")).mode, "ai");
  assert.equal((await helper.interpret("a cheap place", cities, "two")).mode, "local");
  time += 86400000;
  assert.equal((await helper.interpret("a cheap place", cities, "two")).mode, "ai");
});
