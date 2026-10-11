#!/usr/bin/env node
/* longBNB — self-contained server: harvests Airbnb monthly-stay listings,
   validates calendars, caches results, serves the UI. Zero dependencies. Node 18+. */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { HOUR, refreshState, startRefreshScheduler } = require("./lib/refresh");
const { normalizeCriteria, findMatches, createAssistant } = require("./lib/assistant");
const { parseSearchPage } = require("./lib/search-page");
const { DEFAULT_CITIES: CITY_DEFAULTS, listingArea } = require("./lib/cities");

/* optional local .env (does not override already-set env vars; .env is gitignored) */
function loadEnvFile(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
}
loadEnvFile(path.join(__dirname, ".env"));

/* ---------------- config (env-overridable) ---------------- */
const PORT = process.env.PORT || 3000;
const HOSTED = process.env.HOSTED === "1";
const HARVEST_DISABLED = process.env.HARVEST_DISABLED === "1";
const HARVEST_TOKEN = process.env.HARVEST_TOKEN || "";
const REFRESH_MS = Math.max(1, Number(process.env.REFRESH_HOURS) || 24) * HOUR;
const RETRY_MS = Math.max(1, Number(process.env.REFRESH_RETRY_HOURS) || 1) * HOUR;
const DEFAULT_CITIES = (process.env.CITIES || CITY_DEFAULTS.join(",")).split(",").map(city => city.trim()).filter(Boolean);
const MAX_PRICE = parseInt(process.env.MAX_PRICE || "0", 10); // optional global sanity cap; 0 = disabled
/* disjoint price bands searched per city/anchor; "min-max", trailing dash = open top */
const DEFAULT_BANDS = "0-1100,1100-1600,1600-2400,2400-3500,3500-5200,5200-";
function parseBands(spec) {
  const bands = [];
  for (const tok of spec.split(",")) {
    const m = /^(\d+)-(\d*)$/.exec(tok.trim());
    if (!m) return null; // malformed token — reject the whole spec rather than search a wrong range
    bands.push({ min: parseInt(m[1], 10), max: m[2] ? parseInt(m[2], 10) : null });
  }
  return bands.length ? bands : null;
}
let PRICE_BANDS = parseBands(process.env.PRICE_BANDS || DEFAULT_BANDS);
if (!PRICE_BANDS) {
  console.error(`[config] malformed PRICE_BANDS "${process.env.PRICE_BANDS}" — falling back to default bands`);
  PRICE_BANDS = parseBands(DEFAULT_BANDS);
}
const bandLabel = b => b.min + "-" + (b.max ?? "");
const SEARCH_CACHE_V = 3; // v3: every advertised search page, not just page one
const WINDOW_DAYS = parseInt(process.env.WINDOW_DAYS || "48", 10); // runway must start within N days
const MIN_RUNWAY = parseInt(process.env.MIN_RUNWAY || "28", 10);
const CAL_TTL_MS = parseFloat(process.env.CAL_TTL_HOURS || (HOSTED ? "20" : "6")) * 3600e3;
const SEARCH_TTL_MS = parseFloat(process.env.SEARCH_TTL_HOURS || (HOSTED ? "20" : "3")) * 3600e3;
const CACHE_PRUNE_MS = 7 * 24 * 3600e3;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "listings.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SECRET_FILE = path.join(DATA_DIR, "session.secret");

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/* Airbnb's public web-client key + persisted-query hash (embedded in airbnb.com; not account secrets). */
const API_KEY = process.env.AIRBNB_API_KEY || "d306zoyjsyarp7ifhu67rjxn52tv0t20";
const CAL_HASH = process.env.CAL_HASH || "8f08e03c7bd16fcad3c92a3592c19a8b559a0d0855a84028d1163d4733ed9ade";

/* ---------------- helpers ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d2s = d => d.toISOString().slice(0, 10);
const addD = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function writeJSONAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(obj));
  fs.renameSync(file + ".tmp", file); // atomic: a crash mid-write can't corrupt the target
}

function classify(title) {
  const t = (title || "").toLowerCase();
  if (t.startsWith("room") || t.includes("private room") || t.includes("shared")) return "Room";
  if (t.includes("hotel") || t.includes("aparthotel")) return "Hotel";
  return "Whole Home";
}
/* "Portland, OR" -> "Portland--OR" (Airbnb URL slug); already-slugged input passes through */
function slugify(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  if (/^[A-Za-z0-9-]+$/.test(s)) return s; // already a slug
  return s.split(",").map(part => part.trim().split(/\s+/).join("-")).filter(Boolean).join("--") || null;
}
const labelOf = slug => slug.split("--").map(p => p.replace(/-/g, " ")).join(", ");

/* ---------------- auth: sessions, users, oauth providers ---------------- */
/* session secret: env > persisted file on the data volume (survives restarts) */
let SECRET = process.env.SESSION_SECRET || "";
if (!SECRET) {
  try { SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim(); } catch {}
  if (!SECRET) {
    SECRET = crypto.randomBytes(32).toString("hex");
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SECRET_FILE, SECRET); } catch {}
  }
}
const SECURE = process.env.FLY_APP_NAME || process.env.NODE_ENV === "production" ? "; Secure" : "";

let USERS = {};
try { USERS = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch {}
function saveUsers() { writeJSONAtomic(USERS_FILE, USERS); }

const b64u = b => Buffer.from(b).toString("base64url");
const hmac = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
const signTok = obj => { const p = b64u(JSON.stringify(obj)); return p + "." + hmac(p); };
function verifyTok(tok) {
  if (!tok) return null;
  const [p, m] = String(tok).split(".");
  if (!p || !m) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(hmac(p)), Buffer.from(m))) return null;
    const o = JSON.parse(Buffer.from(p, "base64url").toString());
    return o.exp && o.exp < Date.now() ? null : o;
  } catch { return null; }
}
function getUser(req) {
  const m = /(?:^|;\s*)rw_sess=([^;]+)/.exec(req.headers.cookie || "");
  const s = m && verifyTok(decodeURIComponent(m[1]));
  return s && USERS[s.uid] ? USERS[s.uid] : null;
}
function setSession(res, uid) {
  const tok = signTok({ uid, exp: Date.now() + 30 * 864e5 });
  res.setHeader("Set-Cookie", `rw_sess=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${SECURE}`);
}
const baseUrl = req => `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;

/* providers activate when their env keys are set; guest login is on until any provider exists (or ALLOW_GUEST=1) */
const PROVIDERS = {};
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) PROVIDERS.google = true;
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) PROVIDERS.github = true;
if (process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY) PROVIDERS.apple = true;
const GUEST_OK = process.env.ALLOW_GUEST === "1" || !Object.keys(PROVIDERS).length;

/* Sign in with Apple wants a fresh ES256-signed JWT as the client secret */
function appleSecret() {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "ES256", kid: process.env.APPLE_KEY_ID, typ: "JWT" }));
  const p = b64u(JSON.stringify({ iss: process.env.APPLE_TEAM_ID, iat: now, exp: now + 300, aud: "https://appleid.apple.com", sub: process.env.APPLE_CLIENT_ID }));
  const key = crypto.createPrivateKey(process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"));
  const sig = crypto.sign("sha256", Buffer.from(h + "." + p), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return h + "." + p + "." + sig;
}

function rawBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    let tooLarge = false;
    req.on("data", c => {
      if (tooLarge) return;
      b += c;
      if (Buffer.byteLength(b) > 1e5) { tooLarge = true; reject(Object.assign(new Error("Request body too large"), { statusCode: 413 })); }
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("Request aborted")));
  });
}

async function oauthCallback(p, req, res, u) {
  const base = baseUrl(req);
  /* Apple posts the callback (response_mode=form_post); Google/GitHub use query params */
  const params = p === "apple" && req.method === "POST" ? new URLSearchParams(await rawBody(req)) : u.searchParams;
  const fail = msg => { res.statusCode = 400; res.end(`auth failed: ${msg} — <a href="/">back</a>`); };
  if (!verifyTok(params.get("state") || "")) return fail("bad state");
  const code = params.get("code");
  if (!code) return fail("no code");
  let prof = null;
  if (p === "google") {
    const tr = await (await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: base + "/auth/cb/google", grant_type: "authorization_code" }),
    })).json();
    if (!tr.access_token) return fail("token exchange");
    const ui = await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + tr.access_token } })).json();
    prof = { id: "google:" + ui.sub, provider: "google", email: ui.email || null, name: ui.name || ui.email || "Google user", avatar: ui.picture || null };
  } else if (p === "github") {
    const tr = await (await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ code, client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, redirect_uri: base + "/auth/cb/github" }),
    })).json();
    if (!tr.access_token) return fail("token exchange");
    const ui = await (await fetch("https://api.github.com/user", { headers: { Authorization: "Bearer " + tr.access_token, "User-Agent": "longbnb", Accept: "application/vnd.github+json" } })).json();
    prof = { id: "github:" + ui.id, provider: "github", email: ui.email || null, name: ui.name || ui.login, avatar: ui.avatar_url || null };
  } else { // apple
    const tr = await (await fetch("https://appleid.apple.com/auth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: process.env.APPLE_CLIENT_ID, client_secret: appleSecret(), redirect_uri: base + "/auth/cb/apple", grant_type: "authorization_code" }),
    })).json();
    if (!tr.id_token) return fail("token exchange");
    const pay = JSON.parse(Buffer.from(tr.id_token.split(".")[1], "base64url").toString());
    let name = "Apple user";
    try { const uu = JSON.parse(params.get("user") || ""); const n = [uu.name?.firstName, uu.name?.lastName].filter(Boolean).join(" "); if (n) name = n; } catch {}
    prof = { id: "apple:" + pay.sub, provider: "apple", email: pay.email || null, name, avatar: null };
  }
  const ex = USERS[prof.id] || {};
  if (p === "apple" && ex.name) prof.name = ex.name; // Apple only sends the name on first consent
  USERS[prof.id] = { ...ex, ...prof, favs: ex.favs || [], createdAt: ex.createdAt || new Date().toISOString() };
  saveUsers();
  setSession(res, prof.id);
  res.statusCode = 302; res.setHeader("Location", "/"); res.end();
}

/* ---------------- persistent db (listings + calendar cache) ---------------- */
let DB = { harvestedAt: null, cityHarvestedAt: {}, refresh: {}, cities: DEFAULT_CITIES.slice(), listings: [], calCache: {}, searchCache: {} };
try {
  const j = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const savedCities = Array.isArray(j.cities) ? j.cities : [...new Set((j.listings || []).map(listing => listing.city))];
  DB = Object.assign(DB, j);
  DB.calCache = DB.calCache || {};
  DB.searchCache = DB.searchCache || {};
  /* drop legacy city-only keys and any entry whose cached shape predates the current slim() schema */
  for (const [k, e] of Object.entries(DB.searchCache)) if (!k.includes("|") || e?.v !== SEARCH_CACHE_V) delete DB.searchCache[k];
  if (!Array.isArray(DB.cities) || !DB.cities.length) DB.cities = DEFAULT_CITIES.slice();
  if (HOSTED) DB.cities = DEFAULT_CITIES.slice();
  DB.cityHarvestedAt = DB.cityHarvestedAt || {};
  DB.refresh = DB.refresh || {};
  // New coverage must be due immediately, not inherit another city's freshness.
  for (const city of DB.cities) if (!Object.hasOwn(DB.cityHarvestedAt, city)) DB.cityHarvestedAt[city] = savedCities.includes(city) ? DB.harvestedAt : null;
} catch {}

const getRefreshState = () => refreshState(DB, { intervalMs: REFRESH_MS, retryMs: RETRY_MS, disabled: HARVEST_DISABLED });
const assistant = createAssistant({ apiKey: process.env.OPENROUTER_API_KEY });

/* pre-serialized client payload (no caches) so /api/listings is a memory read */
function pack() {
  return JSON.stringify({
    harvestedAt: DB.harvestedAt,
    config: { MAX_PRICE, WINDOW_DAYS, MIN_RUNWAY, STALE_HOURS: REFRESH_MS / HOUR, hosted: HOSTED, aiEnabled: assistant.enabled },
    cityHarvestedAt: DB.cityHarvestedAt,
    cities: DB.cities,
    listings: DB.listings,
  });
}
let CLIENT_JSON = pack();
function saveDB() {
  writeJSONAtomic(DATA_FILE, DB);
  CLIENT_JSON = pack();
}

/* ---------------- harvest: search pass ---------------- */
/* Follow only server-provided cursors; an incomplete traversal is never cached as complete. */
async function searchCity(city, monthlyStart, band) {
  const q = new URLSearchParams({
    "refinement_paths[]": "/homes",
    "flexible_trip_lengths[]": "one_month",
    monthly_start_date: monthlyStart,
    monthly_length: "1",
    date_picker_type: "monthly_stay",
    price_filter_input_type: "0",
    channel: "EXPLORE",
    search_type: "filter_change",
  });
  if (band.min > 0) q.set("price_min", String(band.min));
  if (band.max != null) q.set("price_max", String(band.max));
  const results = [], queued = [null], seen = new Set();
  const firstIds = new Set();
  for (let page = 0; page < queued.length; page++) {
    if (page >= 50) return { results, complete: false };
    const cursor = queued[page];
    if (cursor) q.set("cursor", cursor);
    if (page) await sleep(1200);
    try {
      const url = `https://www.airbnb.com/s/${encodeURIComponent(city)}/homes?${q}`;
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`search HTTP ${res.status}`);
      const parsed = parseSearchPage(await res.text());
      const pageIds = parsed.results.map(r => r.demandStayListing?.id).filter(Boolean);
      if (page && pageIds.length && pageIds.every(id => firstIds.has(id))) return { results, complete: false }; // ignored cursor
      results.push(...parsed.results);
      if (!page) {
        pageIds.forEach(id => firstIds.add(id));
        // The first advertised cursor represents the page already received.
        if (parsed.cursors[0]) seen.add(parsed.cursors[0]);
      }
      for (const next of parsed.cursors) if (!seen.has(next)) { seen.add(next); queued.push(next); }
    } catch (error) {
      if (!page) throw error;
      return { results, complete: false };
    }
  }
  return { results, complete: true };
}

/* project a raw search result down to the flat shape the validate loop reads; bump SEARCH_CACHE_V
   (config section) whenever this shape changes so stale cached entries are dropped on load.
   Defensive against odd upstream shapes — one malformed result must never abort a harvest. */
function slim(r, lid) {
  const p = r.structuredDisplayPrice?.primaryLine || {};
  const c = r.demandStayListing?.location?.coordinate || {};
  const lines = Array.isArray(r.structuredContent?.primaryLine) ? r.structuredContent.primaryLine : [];
  const pics = Array.isArray(r.contextualPictures) ? r.contextualPictures : [];
  let beds = "";
  for (const msg of lines) if (msg && msg.type === "BEDINFO") beds = msg.body || "";
  return {
    __lid: lid,
    title: r.title,
    subtitle: r.subtitle,
    rating: r.avgRatingLocalized || null,
    priceRaw: p.discountedPrice || p.price || "",
    beds,
    imgs: pics.map(x => x && x.picture).filter(Boolean).slice(0, 5),
    lat: c.latitude ?? null,
    lng: c.longitude ?? null,
  };
}

/* ---------------- harvest: calendar pass ---------------- */
async function getCalendar(listingId) {
  const now = new Date();
  const variables = JSON.stringify({ request: { count: 12, listingId: String(listingId), month: now.getMonth() + 1, year: now.getFullYear() } });
  const ext = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: CAL_HASH } });
  const url = `https://www.airbnb.com/api/v3/PdpAvailabilityCalendar/${CAL_HASH}?operationName=PdpAvailabilityCalendar&locale=en&currency=USD&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(ext)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "X-Airbnb-Api-Key": API_KEY }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`calendar HTTP ${res.status}`);
  const d = await res.json();
  const months = d?.data?.merlin?.pdpAvailabilityCalendar?.calendarMonths;
  if (d.errors?.length || !Array.isArray(months) || !months.length) throw new Error("calendar response missing availability");
  const days = [];
  for (const mo of months) for (const day of mo.days || []) days.push([day.calendarDate, !!day.available]);
  if (!days.length) throw new Error("calendar response contains no days");
  return days.sort((a, b) => a[0].localeCompare(b[0]));
}

/* contiguous open stretches: [[lengthDays, startDate], ...] */
function computeRuns(days) {
  const runs = [];
  let cur = 0, start = null;
  for (const [d, avail] of days) {
    if (avail) { if (cur === 0) start = d; cur++; }
    else { if (cur) runs.push([cur, start]); cur = 0; }
  }
  if (cur) runs.push([cur, start]);
  return runs;
}

/* ---------------- harvest orchestration ---------------- */
const status = { running: false, phase: "idle", done: 0, total: 0, found: 0, cached: 0, error: null, startedAt: null, cities: [], warnings: [] };
const warn = msg => { if (status.warnings.length < 20) status.warnings.push(msg); console.log("[warn] " + msg); };

async function harvest(citySubset) {
  if (status.running || HARVEST_DISABLED) return false;
  const cities = (citySubset && citySubset.length ? citySubset : DB.cities).filter(c => DB.cities.includes(c));
  if (!cities.length) return false;
  Object.assign(status, { running: true, phase: "searching", done: 0, total: 0, found: 0, cached: 0, error: null, startedAt: new Date().toISOString(), cities, warnings: [] });
  DB.refresh.lastAttemptAt = status.startedAt;
  DB.refresh.lastError = null;
  try {
    saveDB();
    const today = new Date();
    const todayS = d2s(today);
    const nowMs = Date.now();
    const anchors = [d2s(addD(today, 2)), d2s(addD(today, 19)), d2s(addD(today, 36))]; // flexible start anchors across the window
    const raw = new Map(); // lid -> {r, city}

    let failStreak = 0;   // consecutive failed bands — trips the breaker below
    let blocked = false;  // breaker: once Airbnb is clearly refusing us, stop hammering this harvest
    const failedCities = new Set(); // cities with an incomplete pass — merged, never wholesale-replaced

    for (const city of cities) {
      let dirty = false; // only persist when this city actually wrote new cache entries
      for (const band of PRICE_BANDS) {
        const label = bandLabel(band);
        const key = city + "|" + label;
        const sc = DB.searchCache[key];
        if (sc && nowMs - Date.parse(sc.at) < SEARCH_TTL_MS && Array.isArray(sc.results)) {
          for (const r of sc.results) if (!raw.has(r.__lid)) raw.set(r.__lid, { r, city });
          console.log(`[search] ${city} $${label}: ${sc.results.length} results (cache)`);
          continue;
        }
        if (blocked) { failedCities.add(city); continue; }
        status.phase = `searching ${city} $${label}`;
        const bandResults = new Map(); // lid -> slim result
        let ok = true; // cache only if every anchor fetched + parsed cleanly
        for (const anchor of anchors) {
          let rs = null;
          /* two attempts; the retry waits out a long cool-off first (rate-limit respect) */
          for (let attempt = 0; attempt < 2 && !rs; attempt++) {
            if (attempt) { console.log(`[search] ${city} $${label} @${anchor}: failed — retrying in 20s`); await sleep(20000); }
            try { rs = await searchCity(city, anchor, band); }
            catch (e) { console.log(`[search] ${city} $${label} @${anchor}: ${e.message}`); }
          }
          if (!rs) { // both attempts failed: non-fatal — record and move on to the next band
            ok = false;
            warn(`search failed for ${city} $${label} @${anchor} (after retry)`);
            break;
          }
          if (!rs.complete) {
            ok = false;
            warn(`incomplete pagination for ${city} $${label} @${anchor}`);
          }
          for (const r of rs.results) {
            const b64 = r.demandStayListing?.id || "";
            let lid = "";
            try { lid = Buffer.from(b64, "base64").toString("utf8").replace(/[^\d]/g, ""); } catch {}
            if (!lid || bandResults.has(lid)) continue;
            const s = slim(r, lid);
            bandResults.set(lid, s);
            if (!raw.has(lid)) raw.set(lid, { r: s, city });
          }
          console.log(`[search] ${city} $${label} @${anchor}: ${rs.results.length} results (${raw.size} unique)`);
          await sleep(1200);
        }
        if (!ok) {
          failedCities.add(city);
          if (++failStreak >= 3 && !blocked) { blocked = true; warn("3 consecutive band failures — skipping remaining searches this harvest"); }
        } else {
          failStreak = 0;
          if (DB.cities.includes(city)) { // city may have been deleted mid-harvest — don't resurrect its cache
            DB.searchCache[key] = { at: new Date().toISOString(), v: SEARCH_CACHE_V, results: [...bandResults.values()] };
            dirty = true;
          }
        }
      }
      if (dirty) saveDB(); // incremental: this city's search results are durable before moving on
    }

    status.phase = "validating calendars";
    status.total = raw.size;
    const windowEnd = d2s(addD(today, WINDOW_DAYS));
    const out = [];
    const previousListings = new Map(DB.listings.map(listing => [listing.id, listing]));
    let calendarFailures = 0;

    for (const [lid, { r, city }] of raw) {
      status.done++;
      if (status.done % 25 === 0) saveDB(); // checkpoint: fetched calendars stay durable even mid-city
      const priceStr = String(r.priceRaw || "");
      /* prefer the $-anchored money token ("1 month · $2,100" must not become 1), fall back to bare digits */
      const pm = priceStr.match(/\$[\d,]+/) || priceStr.match(/[\d,]+/);
      const monthly = pm ? parseInt(pm[0].replace(/[^\d]/g, ""), 10) : NaN;
      if (!monthly || monthly < 100 || monthly > 100000 || (MAX_PRICE && monthly > MAX_PRICE)) continue;
      try {
        /* calendar cache: reuse recent pulls instead of re-hitting Airbnb */
        let runs;
        const cc = DB.calCache[lid];
        if (cc && nowMs - Date.parse(cc.checkedAt) < CAL_TTL_MS) {
          runs = cc.runs;
          status.cached++;
        } else {
          try { runs = computeRuns(await getCalendar(lid)); }
          finally { await sleep(500); } // pace real fetch attempts even when they fail — a 429 must not speed up the loop
          DB.calCache[lid] = { checkedAt: new Date().toISOString(), runs };
        }
        /* clamp runs that started in the past to today, then filter to the start window */
        const viable = runs
          .map(([len, s]) => {
            if (s >= todayS) return [len, s];
            const gone = Math.round((Date.parse(todayS) - Date.parse(s)) / 864e5);
            return [len - gone, todayS];
          })
          .filter(([len, s]) => len >= MIN_RUNWAY && s <= windowEnd);
        if (!viable.length) continue;
        const best = viable.reduce((a, b) => (b[0] > a[0] ? b : a));
        out.push({
          id: lid,
          name: r.subtitle || r.title,
          type: classify(r.title),
          beds: r.beds, rating: r.rating,
          monthly,
          imgs: r.imgs,
          lat: r.lat, lng: r.lng,
          city, area: listingArea(city, r),
          runwayDays: best[0], runwayStart: best[1],
          checkedAt: DB.calCache[lid].checkedAt,
          discoveredAt: previousListings.get(lid)?.discoveredAt || new Date().toISOString(),
        });
        status.found = out.length;
        calendarFailures = 0;
        console.log(`[cal] ${lid}: ${labelOf(city)} $${monthly}/mo ${best[0]}d from ${best[1]}`);
      } catch (e) {
        /* a failed calendar check must not delete the listing from the site — merge this city instead of replacing it */
        failedCities.add(city);
        warn(`calendar failed for ${lid} (${labelOf(city)}): ${e.message}`);
        if (++calendarFailures >= 3 || /HTTP (403|429)/.test(e.message)) {
          for (const item of raw.values()) failedCities.add(item.city);
          warn("Calendar checks stopped after repeated failures or rate limiting; keeping last good data.");
          break;
        }
      }
    }

    /* merge: replace only the harvested cities' listings, keep the rest
       (drop results for cities removed mid-harvest). A city whose pass was incomplete
       (failed bands / calendar errors) is merged by id instead of replaced, so a
       rate-limited harvest can't silently wipe previously-good listings. */
    for (const city of cities) {
      if (!out.some(l => l.city === city) && DB.listings.some(l => l.city === city)) {
        failedCities.add(city);
        warn(`empty result for ${city} — keeping last good listings until a complete check succeeds`);
      }
    }
    if (failedCities.size) warn(`incomplete harvest for ${[...failedCities].join(", ")} — merging instead of replacing their listings`);
    const outIds = new Set(out.map(l => l.id));
    DB.listings = DB.listings
      .filter(l => !cities.includes(l.city) || (failedCities.has(l.city) && !outIds.has(l.id)))
      .concat(out.filter(l => DB.cities.includes(l.city)));
    /* prune stale caches */
    for (const [id, c] of Object.entries(DB.calCache)) if (nowMs - Date.parse(c.checkedAt) > CACHE_PRUNE_MS) delete DB.calCache[id];
    for (const [c, s] of Object.entries(DB.searchCache)) if (nowMs - Date.parse(s.at) > CACHE_PRUNE_MS) delete DB.searchCache[c];
    const completedAt = new Date().toISOString();
    for (const city of cities) if (!failedCities.has(city) && DB.cities.includes(city)) DB.cityHarvestedAt[city] = completedAt;
    const fresh = DB.cities.map(city => Date.parse(DB.cityHarvestedAt[city]));
    DB.harvestedAt = fresh.length && fresh.every(Number.isFinite) ? new Date(Math.min(...fresh)).toISOString() : null;
    DB.refresh.lastCompletedAt = completedAt;
    DB.refresh.lastError = failedCities.size ? "Some cities could not be refreshed. Keeping their last good listings." : null;
    saveDB();
    console.log(`[done] ${out.length} listings for ${cities.join(", ")} (${status.cached} calendars from cache) — ${DB.listings.length} total`);
    status.phase = "idle";
  } catch (e) {
    DB.refresh.lastError = "Refresh failed. Keeping the last good listings.";
    try { saveDB(); } catch (saveError) { console.error("[harvest] checkpoint failed:", saveError.message); }
    status.error = e.message;
    status.phase = "error";
    console.error("[harvest] fatal:", e);
  } finally {
    status.running = false;
  }
  return true;
}

/* ---------------- http server ---------------- */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const STATIC = new Map(); // in-memory static cache, invalidated by mtime

const readBody = async req => { try { return JSON.parse(await rawBody(req) || "{}"); } catch (error) { if (error instanceof SyntaxError) return {}; throw error; } };
const json = (res, code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
const publicStatus = () => ({ ...status, hosted: HOSTED, harvestDisabled: HARVEST_DISABLED, harvestedAt: DB.harvestedAt, cityHarvestedAt: DB.cityHarvestedAt, listings: DB.listings.length, firstRun: !DB.harvestedAt, ...getRefreshState() });
function isHarvestAdmin(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return !!HARVEST_TOKEN && Buffer.byteLength(token) === Buffer.byteLength(HARVEST_TOKEN) && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(HARVEST_TOKEN));
}
const finderRequests = new Map();
function allowFinder(req) {
  const now = Date.now();
  const ip = req.headers["fly-client-ip"] || req.socket.remoteAddress || "unknown";
  const entry = finderRequests.get(ip);
  if (entry && now - entry.at < 60000) return ++entry.count <= 15;
  for (const [key, value] of finderRequests) if (now - value.at >= 60000) finderRequests.delete(key);
  if (finderRequests.size >= 5000) return false;
  finderRequests.set(ip, { at: now, count: 1 });
  return true;
}

// A streaming request keeps suspended Fly machines awake for the whole harvest.
function streamHarvest(req, res, task) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  const send = () => { if (!res.destroyed) res.write(JSON.stringify(publicStatus()) + "\n"); };
  send();
  const timer = setInterval(send, 10000);
  const done = () => { clearInterval(timer); if (!res.destroyed) { send(); res.end(); } };
  res.on("close", () => clearInterval(timer));
  if (task) task.finally(done);
  else {
    const wait = setInterval(() => { if (!status.running) { clearInterval(wait); done(); } }, 1000);
    res.on("close", () => clearInterval(wait));
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error("[http]", error.message);
    if (!res.headersSent) json(res, error.statusCode || 500, { error: error.statusCode === 413 ? "Request body too large" : "Request failed. Please try again." });
    else res.end();
  });
});
async function handleRequest(req, res) {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/healthz") return json(res, 200, { ok: true });

  /* ----- auth routes (open) ----- */
  if (u.pathname === "/auth/providers") return json(res, 200, { providers: Object.keys(PROVIDERS), guest: GUEST_OK });
  if (u.pathname === "/auth/guest" && req.method === "POST") {
    if (HOSTED) return json(res, 403, { error: "accounts are disabled on the public instance" });
    if (!GUEST_OK) return json(res, 403, { error: "guest login disabled" });
    const uid = "guest:" + crypto.randomBytes(6).toString("hex");
    USERS[uid] = { id: uid, provider: "guest", name: "Guest", email: null, avatar: null, favs: [], createdAt: new Date().toISOString() };
    saveUsers();
    setSession(res, uid);
    return json(res, 200, { ok: true });
  }
  if (u.pathname === "/auth/logout" && req.method === "POST") {
    res.setHeader("Set-Cookie", `rw_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE}`);
    return json(res, 200, { ok: true });
  }
  const login = u.pathname.match(/^\/auth\/login\/(google|github|apple)$/);
  if (login) {
    const p = login[1];
    if (!PROVIDERS[p]) return json(res, 404, { error: "provider not configured" });
    const base = baseUrl(req);
    const state = signTok({ n: crypto.randomBytes(8).toString("hex"), exp: Date.now() + 600e3 });
    let url;
    if (p === "google") url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: base + "/auth/cb/google", response_type: "code", scope: "openid email profile", state, prompt: "select_account" });
    else if (p === "github") url = "https://github.com/login/oauth/authorize?" + new URLSearchParams({ client_id: process.env.GITHUB_CLIENT_ID, redirect_uri: base + "/auth/cb/github", scope: "read:user user:email", state });
    else url = "https://appleid.apple.com/auth/authorize?" + new URLSearchParams({ client_id: process.env.APPLE_CLIENT_ID, redirect_uri: base + "/auth/cb/apple", response_type: "code", response_mode: "form_post", scope: "name email", state });
    res.statusCode = 302; res.setHeader("Location", url); return res.end();
  }
  const cb = u.pathname.match(/^\/auth\/cb\/(google|github|apple)$/);
  if (cb) {
    try { return await oauthCallback(cb[1], req, res, u); }
    catch (e) { res.statusCode = 500; return res.end("auth error: " + e.message); }
  }

  /* ----- api routes (login required) ----- */
  if (u.pathname.startsWith("/api/")) {
    const user = getUser(req);
    if (u.pathname === "/api/me") {
      if (HOSTED) return json(res, 200, { hosted: true, user: null });
      return user
        ? json(res, 200, { user: { id: user.id, provider: user.provider, name: user.name, email: user.email, avatar: user.avatar } })
        : json(res, 401, { error: "auth required" });
    }
    const publicRead = HOSTED && req.method === "GET" && ["/api/listings", "/api/status"].includes(u.pathname);
    const publicFinder = HOSTED && req.method === "POST" && u.pathname === "/api/assistant";
    const administrative = u.pathname === "/api/harvest" || u.pathname === "/api/cities" || u.pathname.startsWith("/api/cities/");
    if (administrative && (HOSTED || HARVEST_TOKEN) && !isHarvestAdmin(req)) return json(res, 401, { error: "admin token required" });
    if (!user && !publicRead && !publicFinder && !(administrative && isHarvestAdmin(req))) return json(res, 401, { error: "auth required" });

    if (u.pathname === "/api/favorites" && req.method === "GET") return json(res, 200, { favs: user.favs || [] });
    const favm = u.pathname.match(/^\/api\/favorites\/(\d+)$/);
    if (favm && req.method === "POST") {
      user.favs = user.favs || [];
      const i = user.favs.indexOf(favm[1]);
      i >= 0 ? user.favs.splice(i, 1) : user.favs.push(favm[1]);
      saveUsers();
      return json(res, 200, { favs: user.favs });
    }
  }

  if (u.pathname === "/api/listings") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(CLIENT_JSON);
  }
  if (u.pathname === "/api/status") return json(res, 200, publicStatus());
  if (u.pathname === "/api/harvest" && req.method === "POST") {
    if (HARVEST_DISABLED) return json(res, 503, { error: "harvest disabled" });
    if (u.searchParams.get("scheduled") === "1" && !status.running) {
      const lastSuccess = Date.parse(getRefreshState().lastSuccessAt) || 0;
      if (lastSuccess && Date.now() - lastSuccess < Math.min(REFRESH_MS, 20 * HOUR)) return json(res, 200, { ...publicStatus(), skipped: true });
    }
    const started = !status.running;
    const task = started ? harvest() : null;
    if (u.searchParams.get("stream") === "1") return streamHarvest(req, res, task);
    return json(res, 200, { started });
  }
  if (u.pathname === "/api/assistant" && req.method === "POST") {
    if (!allowFinder(req)) return json(res, 429, { error: "Too many searches. Try again in a minute." });
    const body = await readBody(req);
    if (!body || typeof body.message !== "string" || body.message.length > 1000 || (body.filters && (typeof body.filters !== "object" || Array.isArray(body.filters)))) return json(res, 400, { error: "Use a search message of at most 1,000 characters." });
    try {
      normalizeCriteria(body.filters || {}, DB.cities); // reject invalid fields before any model call
      if (!body.message.trim() && !Object.keys(body.filters || {}).length) return json(res, 400, { error: "Add a city, budget, or a short description to start." });
      const interpretation = await assistant.interpret(body.message, DB.cities);
      const criteria = normalizeCriteria({ ...interpretation.criteria, ...(body.filters || {}) }, DB.cities);
      const matches = findMatches(DB.listings, criteria);
      const unavailable = criteria.location && !criteria.cities.length;
      const message = unavailable
        ? `We do not track ${criteria.location} yet. Available cities: ${DB.cities.map(labelOf).join("; ")}.`
        : matches.length
          ? `${matches.length} matching ${matches.length === 1 ? "stay" : "stays"}, cheapest first${criteria.maxMonthly != null ? `, at or below $${criteria.maxMonthly.toLocaleString()}/month` : ""}.`
          : "No current listings match those filters. Try another city, a higher budget, or a shorter stay.";
      return json(res, 200, { message, criteria, mode: interpretation.mode, notice: interpretation.notice || null, matches: matches.slice(0, 12), total: matches.length, freshness: getRefreshState() });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (u.pathname === "/api/cities" && req.method === "POST") {
    const { city } = await readBody(req);
    const slug = slugify(city);
    if (!slug) return json(res, 400, { error: "city required — e.g. \"Portland, OR\"" });
    if (!DB.cities.includes(slug)) { DB.cities.push(slug); DB.cityHarvestedAt[slug] = null; saveDB(); }
    const started = !status.running;
    if (started) harvest([slug]); // fire and forget
    return json(res, 200, { added: slug, label: labelOf(slug), started });
  }
  if (u.pathname.startsWith("/api/cities/") && req.method === "DELETE") {
    const slug = decodeURIComponent(u.pathname.slice("/api/cities/".length));
    DB.cities = DB.cities.filter(c => c !== slug);
    delete DB.cityHarvestedAt[slug];
    DB.listings = DB.listings.filter(l => l.city !== slug);
    for (const k of Object.keys(DB.searchCache)) if (k.startsWith(slug + "|")) delete DB.searchCache[k];
    saveDB();
    return json(res, 200, { removed: slug, cities: DB.cities });
  }

  // static (memory-cached)
  const file = u.pathname === "/" ? "/index.html" : u.pathname;
  const fp = path.join(__dirname, "public", path.normalize(file).replace(/^(\.\.[\/\\])+/, ""));
  if (fp.startsWith(path.join(__dirname, "public")) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const mtime = fs.statSync(fp).mtimeMs;
    let hit = STATIC.get(fp);
    if (!hit || hit.mtime !== mtime) { hit = { mtime, buf: fs.readFileSync(fp) }; STATIC.set(fp, hit); }
    res.setHeader("Content-Type", MIME[path.extname(fp)] || "application/octet-stream");
    return res.end(hit.buf);
  }
  res.statusCode = 404; res.end("not found");
}

server.listen(PORT, () => {
  console.log(`longBNB on http://localhost:${PORT}`);
  console.log(`config: cities=${DB.cities.join("|")} bands=${PRICE_BANDS.map(bandLabel).join(",")} maxPrice=${MAX_PRICE ? "$" + MAX_PRICE : "off"} window=${WINDOW_DAYS}d minRunway=${MIN_RUNWAY}d calTTL=${CAL_TTL_MS / 3600e3}h`);
  startRefreshScheduler({ getState: getRefreshState, isRunning: () => status.running, run: harvest });
});
