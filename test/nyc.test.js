const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { DEFAULT_CITIES, NYC, nycBorough, listingArea } = require("../lib/cities");
const { parseCriteria, normalizeCriteria, findMatches } = require("../lib/assistant");

const now = Date.parse("2026-10-11T12:00:00Z");

test("NYC aliases resolve to New York, while Bay Area remains local", () => {
  for (const location of ["NYC", "New York", "New York City", "New York, NY", "New York City, NY", "New York metro", "New York metro area", "NYC metro"]) {
    assert.deepEqual(normalizeCriteria({ location }, DEFAULT_CITIES, now).cities, [NYC]);
    const criteria = normalizeCriteria(parseCriteria(`A room in ${location} under $2k for 2 months`, DEFAULT_CITIES, now), DEFAULT_CITIES, now);
    assert.deepEqual(criteria.cities, [NYC]);
    assert.equal(criteria.maxMonthly, 2000);
    assert.equal(criteria.minDays, 60);
  }
  const bay = DEFAULT_CITIES.filter(city => city !== NYC);
  for (const location of ["Bay Area", "San Francisco Bay Area"]) {
    assert.deepEqual(normalizeCriteria(parseCriteria(`In ${location} under $1500`, DEFAULT_CITIES, now), DEFAULT_CITIES, now).cities.sort(), bay.slice().sort());
  }
  assert.deepEqual(normalizeCriteria({ location: "all cities" }, DEFAULT_CITIES, now).cities, DEFAULT_CITIES);
  assert.deepEqual(normalizeCriteria({ location: "New York State" }, DEFAULT_CITIES, now).cities, []);
});

test("borough boundaries label NYC while nearby and unlocated results keep honest source labels", () => {
  for (const [name, lat, lng] of [
    ["Manhattan", 40.7549, -73.9840], ["Brooklyn", 40.6782, -73.9442],
    ["Queens", 40.7282, -73.7949], ["Bronx", 40.8448, -73.8648],
    ["Staten Island", 40.5795, -74.1502],
  ]) {
    assert.equal(nycBorough(lat, lng), name);
    assert.equal(listingArea(NYC, { lat, lng }), name + ", NYC");
  }
  for (const [lat, lng] of [[40.75118, -74.04893], [40.730013, -74.157426], [40.7282, -73.64], [37.77, -122.4], [null, null], [NaN, 0]]) {
    assert.equal(nycBorough(lat, lng), null);
  }
  assert.equal(listingArea(NYC, { title: "Room in Jersey City", lat: 40.75118, lng: -74.04893 }), "Jersey City · New York metro");
  assert.equal(listingArea(NYC, { title: "Apartment in Newark", lat: 40.730013, lng: -74.157426 }), "Newark · New York metro");
  assert.equal(listingArea(NYC, { title: "Room in Hoboken" }), "Hoboken · New York metro");
  assert.equal(listingArea(NYC, {}), "New York metro · location unconfirmed");
  assert.equal(listingArea("San-Francisco--CA", { lat: 37.77, lng: -122.4 }), "San Francisco, CA");
});

test("NYC budget results exclude Bay Area listings and retain a strict price ceiling", () => {
  const criteria = normalizeCriteria(parseCriteria("NYC under $2000", DEFAULT_CITIES, now), DEFAULT_CITIES, now);
  const listing = (id, city, monthly) => ({ id, city, monthly, runwayStart: "2026-10-11", runwayDays: 60 });
  const matches = findMatches([listing("nyc", NYC, 1900), listing("expensive", NYC, 2100), listing("sf", DEFAULT_CITIES[0], 1200)], criteria, now);
  assert.deepEqual(matches.map(listing => listing.id), ["nyc"]);
});

test("hosted NYC upgrade keeps New Jersey results across storage, fresh search, and cached refresh", { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "longbnb-nyc-"));
  const fresh = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "listings.json"), JSON.stringify({
    harvestedAt: fresh, cities: DEFAULT_CITIES.filter(city => city !== NYC),
    listings: [
      { id: "old-sf", city: DEFAULT_CITIES[0], monthly: 1000, runwayStart: fresh.slice(0, 10), runwayDays: 60 },
      { id: "old-nj", city: NYC, area: "Jersey City", lat: 40.75118, lng: -74.04893, monthly: 1800, runwayStart: fresh.slice(0, 10), runwayDays: 60 },
    ],
  }));
  const requestLog = path.join(dir, "requests.log");
  const mock = path.join(dir, "mock.cjs");
  fs.writeFileSync(mock, `
    const fs = require('node:fs');
    global.fetch = async input => {
      const url = new URL(input);
      fs.appendFileSync(${JSON.stringify(requestLog)}, url.pathname + '\\n');
      if (url.hostname !== 'www.airbnb.com') throw new Error('unexpected network');
      if (url.pathname.includes('/api/v3/')) {
        const days = Array.from({ length: 90 }, (_, i) => ({ calendarDate: new Date(Date.now() + i * 86400000).toISOString().slice(0, 10), available: true }));
        return Response.json({ data: { merlin: { pdpAvailabilityCalendar: { calendarMonths: [{ days }] } } } });
      }
      const results = [['101', 'Brooklyn', 40.6782, -73.9442], ['202', 'Jersey City', 40.75118, -74.04893], ['303', 'Newark', 40.730013, -74.157426], ['404', 'Hoboken', null, null]].map(([id, locality, latitude, longitude]) => ({
        title: 'Room in ' + locality, subtitle: 'Test stay ' + id,
        demandStayListing: { id: Buffer.from('StayListing:' + id).toString('base64'), location: { coordinate: { latitude, longitude } } },
        structuredDisplayPrice: { primaryLine: { price: '$1,800' } },
      }));
      return new Response('<script id="data-deferred-state-0">' + JSON.stringify({ data: { presentation: { staysSearch: { results: { results, paginationInfo: { pageCursors: ['first'] } } } } } }) + '</script>');
    };
  `);
  const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, PORT: String(port), DATA_DIR: dir, HOSTED: "1", HARVEST_DISABLED: "0", HARVEST_TOKEN: "nyc-test-admin", OPENROUTER_API_KEY: "", PRICE_BANDS: "0-2000" };
  delete env.CITIES;
  const child = spawn(process.execPath, ["--require", mock, "server.js"], { cwd: path.resolve(__dirname, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
  t.after(async () => { child.kill(); await once(child, "exit").catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/healthz")).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(ready, logs);
  const before = await (await fetch(base + "/api/listings")).json();
  assert.deepEqual(before.cities, DEFAULT_CITIES);
  assert.equal(before.cityHarvestedAt[NYC], null);
  assert.equal(before.cityHarvestedAt[DEFAULT_CITIES[0]], fresh);
  assert.ok(before.listings.some(listing => listing.id === "old-nj"), "startup must preserve saved New Jersey listings");
  const response = await fetch(base + "/api/harvest?stream=1", { method: "POST", headers: { Authorization: "Bearer nyc-test-admin" } });
  const final = JSON.parse((await response.text()).trim().split("\n").at(-1));
  assert.equal(final.running, false, logs);
  assert.equal(final.stale, false, logs);
  const after = await (await fetch(base + "/api/listings")).json();
  assert.deepEqual(after.listings.map(listing => listing.id).sort(), ["101", "202", "303", "404", "old-sf"]);
  assert.equal(after.listings.find(listing => listing.id === "101").area, "Brooklyn, NYC");
  assert.equal(after.listings.find(listing => listing.id === "202").area, "Jersey City · New York metro");
  assert.equal(after.listings.find(listing => listing.id === "303").area, "Newark · New York metro");
  assert.equal(after.listings.find(listing => listing.id === "404").area, "Hoboken · New York metro");
  const cachedResponse = await fetch(base + "/api/cities", {
    method: "POST", headers: { Authorization: "Bearer nyc-test-admin" },
    body: JSON.stringify({ city: "New York, NY" }),
  });
  assert.equal((await cachedResponse.json()).started, true);
  const cached = await (await fetch(base + "/api/listings")).json();
  assert.deepEqual(cached.listings, after.listings, "cached refresh must retain the same metro-area results");
  const requests = fs.readFileSync(requestLog, "utf8").trim().split("\n");
  assert.deepEqual(requests.filter(url => url.startsWith("/s/")), Array(3).fill("/s/New-York--NY/homes"));
  assert.equal(requests.filter(url => url.startsWith("/api/v3/")).length, 4);
  const search = await (await fetch(base + "/api/assistant", { method: "POST", body: JSON.stringify({ message: "NYC under $2000" }) })).json();
  assert.equal(search.total, 4);
  assert.deepEqual(search.matches.map(listing => listing.id).sort(), ["101", "202", "303", "404"]);
});
