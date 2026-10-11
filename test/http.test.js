const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");

async function startApp(t, { stale = false, disabled = true, apiKey = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "longbnb-test-"));
  const now = Date.now();
  fs.writeFileSync(path.join(dir, "listings.json"), JSON.stringify({
    harvestedAt: new Date(now - (stale ? 48 : 1) * 3600000).toISOString(),
    cities: ["San-Francisco--CA"], calCache: {}, searchCache: {},
    listings: [{ id: "old", name: "Existing listing", monthly: 1499, type: "Room", city: "San-Francisco--CA", runwayStart: new Date(now).toISOString().slice(0, 10), runwayDays: 90 }],
  }));
  const mock = path.join(dir, "mock.cjs");
  // Deterministic upstream fixture: advertised page 2 has a new listing and a duplicate.
  fs.writeFileSync(mock, `
    const fs = require('node:fs');
    global.fetch = async (input, options = {}) => {
      const url = new URL(input);
      fs.appendFileSync(${JSON.stringify(path.join(dir, "requests.log"))}, url.pathname + ' ' + (url.searchParams.get('cursor') || '') + '\\n');
      if (url.hostname === 'openrouter.ai') {
        const location = options.headers.Authorization === 'Bearer server-test-key' ? 'Oakland' : 'San Francisco';
        return Response.json({ choices: [{ message: { content: JSON.stringify({ location }) } }] });
      }
      if (url.hostname !== 'www.airbnb.com') throw new Error('unexpected network');
      if (url.pathname.includes('/api/v3/')) {
        const request = JSON.parse(url.searchParams.get('variables')).request;
        if (fs.existsSync(${JSON.stringify(path.join(dir, "fail-calendars"))})) return Response.json({ errors: [{ message: 'rotated query' }] });
        const days = Array.from({ length: 100 }, (_, i) => ({ calendarDate: new Date(Date.now() + i * 86400000).toISOString().slice(0,10), available: true }));
        return Response.json({ data: { merlin: { pdpAvailabilityCalendar: { calendarMonths: [{ days }] } } } });
      }
      const ids = url.searchParams.get('cursor') ? ['101', '102'] : ['101'];
      const results = ids.map(id => ({ title: 'Private room', subtitle: 'Test room ' + id, demandStayListing: { id: Buffer.from('StayListing:' + id).toString('base64') }, structuredDisplayPrice: { primaryLine: { price: '$1,200' } } }));
      const data = { data: { presentation: { staysSearch: { results: { results, paginationInfo: { pageCursors: ['first', 'second'] } } } } } };
      return new Response('<script id="data-deferred-state-0">' + JSON.stringify(data) + '</script>');
    };
  `);
  const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ["--require", mock, "server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, HOSTED: "1", HARVEST_DISABLED: disabled ? "1" : "0", HARVEST_TOKEN: "test-admin-only", OPENROUTER_API_KEY: apiKey, CITIES: "San-Francisco--CA", PRICE_BANDS: "0-2000", CAL_TTL_HOURS: "0", SEARCH_TTL_HOURS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = ""; child.stdout.on("data", x => { logs += x; }); child.stderr.on("data", x => { logs += x; });
  t.after(async () => { child.kill(); await once(child, "exit").catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/healthz")).ok) return { base, dir, logs: () => logs }; } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("App did not start: " + logs);
}

test("hosted API permits searching but protects refreshes and handles malformed bodies", async t => {
  const { base } = await startApp(t);
  assert.equal((await (await fetch(base + "/api/me")).json()).hosted, true);
  assert.equal((await fetch(base + "/api/harvest", { method: "POST" })).status, 401);
  assert.equal((await fetch(base + "/api/cities", { method: "POST", body: '{}' })).status, 401);
  const search = await fetch(base + "/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "SF under $1500 for 2 months" }) });
  const result = await search.json();
  assert.equal(search.status, 200);
  assert.equal(result.total, 1);
  assert.equal(result.matches[0].monthly, 1499);
  assert.equal(result.mode, "local");
  for (const body of ['null', '{bad}', JSON.stringify({ message: "hi", filters: { maxMonthly: -5 } })]) {
    assert.equal((await fetch(base + "/api/assistant", { method: "POST", body })).status, 400);
  }
  const page = await (await fetch(base)).text();
  assert.match(page, /Where do you want to live/);
  assert.equal((await fetch(base + "/finder.js")).status, 200);
  assert.equal((await fetch(base + "/api/harvest?stream=1", { method: "POST", headers: { Authorization: "Bearer test-admin-only" } })).status, 503);
});

test("a stale startup catches up, follows page 2, and an overlapping stream joins the job", { timeout: 20000 }, async t => {
  const { base, dir, logs } = await startApp(t, { stale: true, disabled: false });
  const response = await fetch(base + "/api/harvest?stream=1", { method: "POST", headers: { Authorization: "Bearer test-admin-only" } });
  assert.equal(response.headers.get("content-type"), "application/x-ndjson");
  const updates = (await response.text()).trim().split("\n").map(JSON.parse);
  const final = updates.at(-1);
  assert.equal(final.running, false, logs());
  assert.equal(final.stale, false, logs());
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "listings.json")));
  assert.deepEqual(saved.listings.map(x => x.id).sort(), ["101", "102"]);
  const requests = fs.readFileSync(path.join(dir, "requests.log"), "utf8").trim().split("\n");
  assert.equal(requests.filter(x => x.startsWith("/s/")).length, 6); // 3 anchors x 2 pages; no duplicate job
  assert.equal(requests.filter(x => x.startsWith("/api/v3/")).length, 2);
  assert.ok(saved.cityHarvestedAt["San-Francisco--CA"]);
  const skipped = await (await fetch(base + "/api/harvest?stream=1&scheduled=1", { method: "POST", headers: { Authorization: "Bearer test-admin-only" } })).json();
  assert.equal(skipped.skipped, true);
  const runner = spawn(process.execPath, ["scripts/refresh.mjs"], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, LONG_BNB_URL: base, HARVEST_TOKEN: "test-admin-only" }, stdio: ["ignore", "pipe", "pipe"] });
  let runnerOutput = "";
  runner.stdout.on("data", x => { runnerOutput += x; }); runner.stderr.on("data", x => { runnerOutput += x; });
  const [runnerCode] = await once(runner, "exit");
  assert.equal(runnerCode, 0, runnerOutput);
  assert.match(runnerOutput, /Already fresh; no downloads needed/);
  const before = saved.harvestedAt;
  fs.writeFileSync(path.join(dir, "fail-calendars"), "1");
  const failed = await (await fetch(base + "/api/harvest?stream=1", { method: "POST", headers: { Authorization: "Bearer test-admin-only" } })).text();
  assert.ok(JSON.parse(failed.trim().split("\n").at(-1)).lastError);
  const retained = JSON.parse(fs.readFileSync(path.join(dir, "listings.json")));
  assert.equal(retained.harvestedAt, before);
  assert.equal(retained.listings.length, 2);
});

test("browser AI key is request-scoped, validated, and never exposed or persisted", async t => {
  const { base, dir, logs } = await startApp(t);
  const search = await fetch(base + "/api/assistant", { method: "POST", body: JSON.stringify({ message: "a cheap place", clientApiKey: "browser-test-key" }) });
  const text = await search.text();
  assert.equal(search.status, 200);
  assert.equal(search.headers.get("cache-control"), "no-store");
  assert.equal(JSON.parse(text).mode, "ai");
  assert.equal(JSON.parse(text).total, 1);
  assert.ok(!text.includes("browser-test-key"));
  assert.ok(!logs().includes("browser-test-key"));
  assert.ok(!fs.readFileSync(path.join(dir, "listings.json"), "utf8").includes("browser-test-key"));
  assert.equal((await (await fetch(base + "/api/listings")).json()).config.aiEnabled, false);
  for (const clientApiKey of [{}, "short", "bad key with spaces", "x".repeat(513)]) {
    assert.equal((await fetch(base + "/api/assistant", { method: "POST", body: JSON.stringify({ message: "a cheap place", clientApiKey }) })).status, 400);
  }
});

test("server AI configuration ignores browser credentials and never exposes the server key", async t => {
  const { base, logs } = await startApp(t, { apiKey: "server-test-key" });
  const configText = await (await fetch(base + "/api/listings")).text();
  assert.equal(JSON.parse(configText).config.aiEnabled, true);
  assert.ok(!configText.includes("server-test-key"));
  const response = await fetch(base + "/api/assistant", { method: "POST", body: JSON.stringify({ message: "a cheap place", clientApiKey: { ignored: true } }) });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(text).criteria.location, "Oakland");
  assert.ok(!text.includes("server-test-key"));
  assert.ok(!logs().includes("server-test-key"));
});
