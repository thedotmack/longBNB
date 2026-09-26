# Plan: Polish Price/Length Filters and Avoid-Zone Drawing Holistically

All work is in `public/index.html` (single-file app, ~1170 lines). `server.js` is read-only reference. No new dependencies, no build step. Line numbers below refer to the current working tree (uncommitted diff on top of a550bc0).

## Phase 0 — Documentation Discovery (COMPLETE)

Sources consulted:
- `server.js:13` — `MAX_PRICE = parseInt(process.env.MAX_PRICE || "1600")`; `fly.toml:13` confirms production `MAX_PRICE='1600'`; `server.js:292` drops any listing with `monthly > MAX_PRICE`. **Therefore every listing is ≤ $1,600/mo — hardcoded bands "under $2k / $2k–3.5k / $3.5k–5k / $5k+" are 100%/0%/0%/0%.**
- `server.js:15` — `MIN_RUNWAY = 28`; `server.js:312` drops runs `< MIN_RUNWAY`; `server.js:217` fetches a 12-month calendar → `runwayDays` max ≈ 350. **Therefore "1 week+" (≥7) matches everything and "1 year+" (≥365) matches nothing; `l.overYear` (index.html:449) is unreachable dead code at current config.**
- `server.js:171-178` — `pack()` already sends `config: { MAX_PRICE, WINDOW_DAYS, MIN_RUNWAY }` in the `/api/listings` payload; the client currently ignores it (`loadData()` reads only `listings`, `cities`, `harvestedAt`).
- `public/index.html` full read — integration map in the audit (state:455, filtered():457-463, counts():743-756 called only from loadData():1123, renderMap fit key:574-576, initMaps:545-557 with early return at 546, mobile media queries 82-110, keydown handler 1034-1039, avoid-zone block 590-645).
- No local or reachable listing data: `data/` is gitignored and absent; deployed `/api/listings` is 401 behind auth. Bands must be **derived at runtime from DATA + j.config**, never hardcoded.

Allowed APIs / commands (verified to exist):
- Leaflet 1.9.4 (CDN, index.html:415): `L.polygon`, `L.polyline`, `L.circleMarker`, `layer.bindPopup` / `L.popup`, `map.mouseEventToLatLng(ev)`, `map.dragging.disable()/enable()`, `map.doubleClickZoom.disable()/enable()`, `layer.setStyle`, `map.removeLayer`, `{interactive:false}` option.
- DOM: `setPointerCapture`, `pointerdown/move/up/cancel`, `localStorage`, `replaceChildren`.
- Verification: `node --check`, `python3` for script extraction, `grep -n`.

Anti-pattern guards (global):
- Do NOT invent Leaflet APIs — there is no `L.buffer`; stroke buffering must be hand-rolled with lat/lng math (equirectangular approximation is fine at city scale).
- Do NOT add libraries (no turf.js, no CDN additions).
- Do NOT restructure the file or rename existing functions/ids; extend in place, matching existing style (mono-font pills, `box-shadow:2px 2px 0 var(--line)`, `.pill`/`.sgroup` conventions).
- Do NOT touch `server.js`.
- Every listing-count shown anywhere must be computed, never assumed.

---

## Phase 1 — Data-driven, coherent sidebar filters

What to implement (copy patterns, do not restructure):

1. **Delete the hardcoded price/length pills from the HTML** (the 9 `data-pr`/`data-len` buttons added under `<h5>price / mo</h5>` and `<h5>min length</h5>`). Replace with two empty containers styled like `#cityPills` (index.html:358-360 pattern): `<h5>price / mo</h5><span id="pricePills" style="display:contents"></span>` and `<h5>min length</h5><span id="lenPills" style="display:contents"></span>`.
2. **Build bands at load time** in a new `buildBands()` called from `loadData()` after `prep()`:
   - Read `j.config` in `loadData()` and store it (`CFG = j.config || {}`).
   - Price: sort `DATA.map(l=>l.monthly)`; cut at quartiles, round cutpoints to nearest $50; produce up to 4 contiguous bands `[min,q1) [q1,q2) [q2,q3) [q3,∞)`; drop duplicate/empty bands (small datasets → fewer pills). Labels: `under $q1`, `$q1–q2`, `$q2–q3`, `$q3+` (short `$1.2k` style via a helper).
   - Length: candidate thresholds `[30,60,90,120,180,270,365]` filtered to those that are *selective* (0 < matching count < DATA.length); keep at most 4. Labels `1 mo+`, `2 mo+`, `3 mo+`, `4 mo+`, `6 mo+`, `9 mo+`, `1 yr+`.
   - Hide a group's `<h5>` and container entirely when it has no selective bands or DATA is empty.
   - Render each group with a leading **"any"** pill (default on) so all sidebar groups share the type-group's radio-with-All model (index.html:341). Remove the click-again-to-clear special case from the `#filters` click handler — "any" replaces it. Store `state.price` as `[min,max]` and `state.minLen` as a number, same as now.
3. **Faceted live counts.** Replace the global-DATA count loops in `counts()`: each pill's count = listings matching **all other active filters** plus that pill's own predicate (facet counting). Add a small helper `filteredExcept(key)` that runs the `filtered()` predicate minus one dimension (`type` | `price` | `len` | `city` | `fav` | `avoid`). Recompute pill counts on every `render()` (call a `syncCounts()` from `render()`), including the type and city pill counts (fixes the pre-existing staleness at 744-747 and 766). Keep `cAll`-style `·N` formatting.
4. **Persist filters.** Save `{filter, city, favOnly, price, minLen}` to `localStorage.rwFilters` on every filter change; restore in `loadData()` after bands are built, validating each value (city must be in `CITIES`, price must match a generated band's bounds or be dropped, minLen must be one of the generated thresholds). Zones already persist (`rwAvoid`) — this makes the whole filter state symmetric.
5. **Empty-state + clear-all.** When `DATA.length > 0` but `filtered().length === 0`: render a single `.empty` block in place of the month grid / week grid / day list saying which filters are active (e.g. `nothing matches: Room · $1.2k+ · 3 mo+ · 2 avoid zones`) with a **`clear filters`** button that resets `state.filter/city/price/minLen/favOnly` (NOT avoid zones — those are cleared from their own control) and re-renders. The hero head in this case must say `0 match your filters` instead of `no move-ins this week — keep scrolling` (index.html:836). Day view's misleading empty copy (960-963) gets the same treatment when filters are the cause.
6. **Mobile order + legibility** (≤880px block, index.html:102-110):
   - Honor the file's own comment (line 86): hero first. Change `aside{order:-3}` → `aside{order:-2}` and `main{order:-2}` → `main{order:-3}` so the phone order is: move-in-now hero/calendar, filters, map.
   - Stop hiding group labels: replace `.sgroup h5{display:none}` with an inline compact style (e.g. `font-size:.5rem; padding:.32rem .3rem 0 0; margin:0; width:auto`) so `price/mo` and `min length` still label their pills in the flowing row.
   - Give `#refreshBtn` a distinguishing style on mobile (keep `border-color:var(--ink)`; add the ⟳ prefix it already has — verify it doesn't read as just another filter pill; a `margin-left:auto` is acceptable).
7. **A11y:** all filter pills get `aria-pressed` synced with `.on`; group `<h5>`s keep working as visual labels.

Verification checklist:
- `grep -c 'data-pr=' public/index.html` → 0 in static HTML (bands are runtime-built).
- `grep -n 'j.config' public/index.html` → present in `loadData`.
- `grep -n 'rwFilters' public/index.html` → save + restore sites.
- `grep -n 'clear filters' public/index.html` → empty-state button exists.
- `grep -n "order:-3" public/index.html` → appears for `main`, not `aside`.
- Extract script (`python3` regex) → `node --check` passes.
- Node fixture test: paste `buildBands`-equivalent logic into node with a synthetic 20-listing array (monthly 900–1600, runwayDays 28–350) → bands are contiguous, non-empty, ≤4 per group, no `$5k+`-style dead band possible.

Anti-pattern guards:
- No hardcoded dollar or day cutpoints anywhere in JS or HTML — everything from DATA/CFG.
- Do not remove the type/`All`, cities/`Everywhere`, favorites pills or change their ids.
- `counts()` may be renamed/absorbed but `cAll/cRoom/cHome/cHotel` ids must keep working.

---

## Phase 2 — Avoid zones that behave like the marker they show

What to implement:

1. **Fix the containing-block escape (highest severity).** In the `@media(max-width:1120px)` rule (index.html:82), `#mapwrap` becomes `position:static`, so `.mapbtns`/`#drawHint` abspos against the viewport and hide under the header. Change to `position:relative` (keep `height:260px;min-height:0`).
2. **Make exclusion match the fat brush.** On `pointerup`, store each zone as `{poly:[[lat,lng],...], buf:<meters>}` where `buf` = half the 14px brush width converted to meters at the draw-time zoom (`meters ≈ px * 156543.03392 * cos(lat·π/180) / 2^zoom`). `inAvoid(l)` = point-in-polygon **OR** distance from `[l.lat,l.lng]` to any path segment < `buf` (equirectangular point-to-segment distance in meters). Migrate old-format `localStorage.rwAvoid` entries (bare arrays) by wrapping them with a default `buf` of 0 — do not crash on old data. Render each zone as the filled polygon **plus** a `weight:14, opacity:.35` polyline of the same path so the visual matches the semantics. Discard strokes whose total path length is < ~30px (phantom-zone guard replacing the bare `strokePts.length > 2` check).
3. **Draw-mode ergonomics:**
   - `Escape` exits draw mode (add to the existing keydown handler at 1034-1039, checked before the zoom/overlay branches).
   - Disable `doubleClickZoom` while drawing; re-enable on exit (dragging already handled).
   - Suppress listing-marker hover/tooltips while drawing: gate the marker `mouseover`/`mousemove` handlers (567-571) on `!drawMode`.
   - Handle `pointercancel` identically to a discarded `pointerup` (remove stroke layer, reset). Ignore `pointerdown` when a stroke is already active (multi-touch guard) instead of leaking the first polyline.
4. **Per-zone delete.** Zones become `interactive:true` with a `bindPopup` containing a single `remove this zone` button that splices that zone from `AVOID`, saves, re-renders zones + app. (Popup only opens when NOT in draw mode; while drawing, zone clicks are inert.)
5. **Sidebar presence.** New `<h5>map</h5>` group in `#filters` with a single dynamic pill (id `avoidPill`, hidden when no zones): `🖍 N zone(s) · M hidden ✕` where `M` = `filteredExcept('avoid').length - filtered().length` (uses Phase 1's helper). Clicking the ✕ clears all zones (same action as `#clearDrawBtn`); clicking the pill body scrolls the map into view on mobile. Update it from `syncCounts()`/`render()` so it's always live — this is the signal that fixes "zones silently hide listings," including when viewing a city with no visible zones.
6. **Resilience + selection coherence:**
   - If Leaflet fails to load (`initMaps` early return at 546), zones must NOT filter: gate `inAvoid` on `MAP` being truthy. Currently persisted zones would otherwise hide listings with no UI to clear them.
   - In `render()`, if `state.sel` exists but is no longer in `filtered()`, skip the green runway wash (`buildCell:800`, `renderWeek:933`) — don't paint the calendar for a hidden listing. Leave any open overlay alone.
   - Add `AVOID.length` to the map fit key (574) so zone changes participate in fit bookkeeping; keep `skipFit` behavior.
7. **Cosmetics/a11y:** `.mapbtns button` shadow → `box-shadow:2px 2px 0 var(--line)` (theme-correct, matches `.nav button:157`); zone `fillOpacity` .16 → .22 (legible on inverted dark tiles); `#clearDrawBtn` always shows the count (`✕ 1`, not bare `✕`); `#drawBtn` gets `aria-pressed` + `aria-label="draw avoid zones"`; hint text stays accurate to the new brush semantics.

Verification checklist:
- `grep -n 'position:relative' public/index.html` → inside the 1120px `#mapwrap` rule.
- `grep -n 'pointercancel' public/index.html` → handler present.
- `grep -n 'buf' public/index.html` → zone objects carry a buffer; `rwAvoid` migration path present.
- `grep -n 'aria-pressed' public/index.html` → drawBtn + pills.
- Extract script → `node --check` passes.
- Node fixture test for geometry: with a square polygon around `[37.77,-122.42]` and `buf=150`, a point inside → excluded; a point 100m outside an edge → excluded (buffer); a point 500m away → kept. With a straight-line "stroke" (degenerate polygon) and `buf=150`, a point 100m off the line → excluded (this is the case that previously failed).
- Old-format localStorage value `[[[37.7,-122.4],...]]` loads without throwing.

Anti-pattern guards:
- No `L.buffer`, no turf — hand-rolled math only, ~15 lines.
- Do not make zones editable/draggable (Leaflet.Editable etc. doesn't exist here).
- Do not auto-clear zones on city switch — the sidebar pill is the awareness mechanism.
- Keep `localStorage.rwAvoid` as the single source; no server round-trip.

---

## Phase 3 — Final verification

1. Extract the inline script (`python3` regex used in earlier phases) → `node --check`.
2. Re-run every grep assertion from Phases 1–2 in one pass; all must hit.
3. Fixture run: write a synthetic `listings.json` (12 listings: monthly spread 900–1600, runwayDays 28/45/90/200/350 mix, lat/lng around SF, two with `lat:null`) into a scratch `DATA_DIR`, start `node server.js` on a scratch port with `DATA_DIR` + `SESSION_SECRET` env, `curl` `POST /auth/guest` with a cookie jar, `GET /api/listings` → confirm `config` is present in payload and listings round-trip. Kill the server.
4. Anti-pattern sweep: `grep -n '2000-3500\|3500-5000\|5000-Infinity' public/index.html` → 0 hits; `grep -n 'display:none' public/index.html` → `.sgroup h5{display:none}` gone.
5. Report a diffstat and any deviations from this plan.
