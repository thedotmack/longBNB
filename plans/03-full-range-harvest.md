# Plan: Full-Range Price-Banded Harvest with Safe Caching

Goal: the harvester downloads the FULL price spectrum of month-to-month listings (today capped at $1,600/mo) by searching in disjoint price bands, with caching that is band-aware, memory-safe at Fly's 256–512MB scale, and resilient to Airbnb failures. All server work is in `server.js`; `public/index.html` already builds its filter bands from data quantiles and needs no changes. Deploy config in `fly.toml`.

## Phase 0 — Documentation Discovery (COMPLETE)

Sources consulted:
- `server.js` full read. Search is HTML scraping of `airbnb.com/s/<city>/homes` (`:187-212`): one GET = page 1 only, **no pagination params anywhere**; 3 date anchors per city (`:252`) are the only multiplier. `price_max` sent at `:195`; **post-filter drop `monthly > MAX_PRICE` at `:292`** — both must change together.
- **Live probe (scratchpad/probe.mjs, run 2026-08-15, SF, HTTP 200s):** `price_min` IS honored — band 1600–2600 → 24 results, all in-band, **24/24 ids absent from the price_max=1600 set**. Page yields 18–26 results. Unfiltered search → only 26 results spanning $988–$11,734 (cheap inventory crowded out ⇒ banding, not cap-removal, is the fix). Anchor overlap 7/18 ⇒ keep all 3 anchors. Price strings parse as `$2,239` even above the old cap.
- Caching (`server.js:161-184, 257, 279, 297-302`): `searchCache` keyed **by city slug only** — banded searches would collide; it stores **raw untrimmed Airbnb objects** (the dominant disk/memory cost). `calCache` (runs per listing id, TTL 6h, prune 7d) is price-agnostic and fully reusable — expansion invalidates nothing there. `saveDB()` (`:180-184`) does full sync stringify ×2 (DB + CLIENT_JSON) and a **non-atomic `writeFileSync`**; called ONCE at `:341` after the whole harvest — a crash mid-harvest loses everything; corrupt file ⇒ silent empty-DB reset (`:168`).
- Failure modes (`:200-203, 276, 293-331`): `res.ok` never checked; a 429/challenge page ⇒ "0 results", **which gets cached with a fresh timestamp at `:279`** and poisons the next 3h. No retry/backoff anywhere. Sleeps: 1.2s/search (`:277`), 0.5s/uncached calendar (`:303`).
- Scale math: 6 bands × 3 anchors × 3 cities = 54 searches (~2 min incl. sleeps); ~250–450 unique listings ⇒ same count of calendar fetches (~4–8 min). Cold harvest ≈ **8–15 min**, ~300–500 requests total.
- `fly.toml`: `MAX_PRICE='1600'` at `[env]` (line 13) must go; `memory = '256mb'` (line 28) is the OOM ceiling given saveDB's 3× serialization; volume `longbnb_data`→`/data` survives deploys (verified in plan 01). Post-deploy, old bare-city `searchCache` keys must not be reused (band-keying makes them natural misses).
- Client check: `grep -nE '\b(1600|2000|2500|3000)\b' public/index.html` → CSS z-indexes only. `buildBands()` uses quantiles of DATA; `fmtK` renders `$2.5k`+; `restoreFilters` self-heals stale bands. `l.overYear` stays unreachable (12-mo calendar) — harmless.

Allowed APIs / commands (verified to exist):
- Airbnb search page params: everything currently sent at `server.js:188-199` **plus `price_min`** (probe-verified). NOTHING else — no `items_offset`, no cursor (unverified, do not use).
- `PdpAvailabilityCalendar` persisted query exactly as at `:215-226`.
- Node built-ins: `fs.writeFileSync`, `fs.renameSync`, `fs.mkdirSync`, `URLSearchParams`, global `fetch` (Node 18+, see Dockerfile).
- `fly deploy`, `fly logs`, `curl` with cookie jar (`POST /auth/guest` → `rw_sess` cookie; note `/api/harvest` and `/api/status` are currently unauthenticated — do not "fix" that in this plan).

Anti-pattern guards (global):
- Do NOT invent pagination (`items_offset`/`cursor`) — unverified against the HTML endpoint.
- Do NOT parallelize Airbnb requests — keep the serial + sleep model; volume comes from more queries, not concurrency.
- Do NOT restructure `server.js` or rename its exported behaviors/endpoints; the client's `/api/status` field names (`running,phase,done,total,found,cached`) and `/api/listings` payload shape (`harvestedAt,config,cities,listings`) are contracts.
- Do NOT touch `public/index.html`.
- Never cache a failed or empty search response.

---

## Phase 1 — Price-banded search + band-aware, slim cache

What to implement in `server.js`:

1. **`PRICE_BANDS` env** (`:13` area): comma list of `min-max` with open top as trailing dash. Default: `"0-1100,1100-1600,1600-2400,2400-3500,3500-5200,5200-"`. Parse once into `[{min,max|null}]`. Keep `MAX_PRICE` env as an OPTIONAL global sanity cap: default `"0"` = disabled; post-filter at `:292` becomes `if (!monthly || (MAX_PRICE && monthly > MAX_PRICE)) continue;` plus a garbage guard `monthly < 100 || monthly > 100000 → drop`.
2. **`searchCity(city, monthlyStart, band)`**: send `price_min` when `band.min > 0`, `price_max` only when `band.max != null` (copy the probe's param pattern). The harvest loop becomes cities × anchors × bands, sequential, keeping the existing 1.2s sleep per search.
3. **Band-aware cache key**: `DB.searchCache[city + "|" + band.min + "-" + (band.max ?? "")]`. On DB load, drop any legacy keys without `"|"` (one-line migration). TTL logic unchanged.
4. **Slim what's cached**: store not the raw Airbnb objects but a deep-pick keeping ONLY the paths the validate loop reads (`:267-273, 289-291, 318-328`): `demandStayListing.id`, `structuredDisplayPrice.primaryLine.{discountedPrice,price}`, and the exact fields the listing projection consumes (name/title, coordinates, pictures ≤5, type/room info, beds, rating, area). Preserve the nested shape so the downstream code at `:289-328` is untouched. Stamp `__lid` before caching (it already is).
5. **Never cache failures**: only write `DB.searchCache[key]` when the fetch was `res.ok` AND the deferred-state blob was found AND parsing succeeded. Empty-but-valid result sets MAY be cached (a genuinely empty band is real signal) — distinguish "blob present, 0 listings" (cache) from "blob missing" (don't cache, count as failure).
6. **Price parse hardening** (`:289-291`): extract the first `\$?[\d,]+` match and strip commas, instead of stripping all non-digits from the whole string; guards the `"$2,100 for 1 month" → 21001` failure.
7. **Status visibility**: while searching, set `status.phase = "searching " + city + " $" + bandLabel` (client renders phase verbatim); keep all existing field names/types. `status.total` for the calendar phase already counts unique listings — unchanged.
8. **Dedupe**: unchanged (`raw` Map by lid) — bands are disjoint by construction; the Map handles any edge-of-band duplicates.

Verification checklist:
- `node --check server.js`.
- `grep -n 'price_min' server.js` → present; `grep -n 'PRICE_BANDS' server.js` → env parse with the default string.
- Unit-style fixture (node, scratchpad): band parser handles `"0-1100,5200-"` → `[{min:0,max:1100},{min:5200,max:null}]`; price parser: `"$1,444"`→1444, `"$2,100 for 1 month"`→2100, `""`→NaN-drop.
- Legacy cache migration: feed a DB object with `searchCache:{"San-Francisco--CA":{...}}` → key dropped on load, no throw.
- Live smoke (one city, real network): `DATA_DIR=<scratch> CITIES=Daly-City--CA PORT=<scratch> node server.js` → `POST /api/harvest` → poll `/api/status` until idle → `/api/listings` (guest cookie) shows listings with `monthly` BOTH below and above 1600, and `listings.json` on disk has band-keyed searchCache entries that are slim (spot-check: no `contextualPictures`/`structuredContent` blobs).

Anti-pattern guards: bands must be disjoint and ordered but NOT hardcoded anywhere except the env default; do not remove the 3-anchor loop; do not change `pack()`.

---

## Phase 2 — Durability: incremental atomic saves, failure handling, memory headroom

What to implement:

1. **Atomic writes**: `saveDB()` writes to `DATA_FILE + ".tmp"` then `fs.renameSync` over the original. Same for `users.json` if trivially reachable via the same helper (`:180-184` / wherever users are saved) — if users use a separate writer, leave it.
2. **Incremental persistence**: call `saveDB()` after each city completes the calendar phase (inside the `:255` cities loop), not only at `:341`. A crash then loses at most one city's work, and every fetched calendar is already in `calCache` on disk.
3. **Search failure handling**: on non-`res.ok` or missing deferred-state, retry ONCE after a 20s sleep; on second failure, record it (`status.error = "search blocked for <city>"` is too destructive — instead add a non-fatal `status.warnings` array, appended, max ~20 entries) and continue to the next band. Calendar fetches: check `res.ok`; existing try/catch-continue stays.
4. **Fly memory**: `fly.toml` `memory = '256mb'` → `'512mb'` (line ~28). With the slim cache this is comfortable headroom, and it's the difference between an OOM losing a 15-minute harvest and not.
5. **fly.toml env**: remove `MAX_PRICE = '1600'`; add `PRICE_BANDS` explicitly (same value as the code default, for visibility).

Verification checklist:
- `node --check server.js`; `grep -n 'renameSync' server.js`; `grep -n 'warnings' server.js`.
- `grep -n 'MAX_PRICE' fly.toml` → 0 hits; `grep -n 'PRICE_BANDS\|512mb' fly.toml` → both present.
- Kill-test locally: start a harvest against the scratch DATA_DIR, `kill -9` the server mid-calendar-phase, restart → `listings.json` parses, previously completed cities' listings present, harvest resumable.
- `/api/status` still returns all original fields (curl + jq keys check) so the client poller is unbroken.

Anti-pattern guards: no new dependencies; `status` object stays backward-compatible (only ADD fields); do not auto-retry more than once per search (rate-limit respect).

---

## Phase 3 — Deploy + production full harvest + live verification

1. Commit both files + this plan; push to `origin main`.
2. `fly deploy --remote-only`; confirm healthy.
3. Trigger production harvest: `curl -X POST https://<your-app>.fly.dev/api/harvest`; poll `/api/status` every ~30s until `running:false` (expect 8–20 min; do NOT re-trigger while running).
4. Verify: guest-auth cookie jar → `GET /api/listings` → report: listing count (expect several× the old ~dozens), `monthly` min/median/max (must span well above $1,600), per-band counts, `runwayDays` spread, and `warnings` from `/api/status` if any. Check `fly logs` for OOM/restart evidence (must be none).
5. Spot-check the UI at https://<your-app>.fly.dev/ — sidebar price bands should now show quartiles of the expanded range (e.g. up to `$5k+`-style top band) computed client-side with zero client changes.
6. Report diffstat + any deviations.
