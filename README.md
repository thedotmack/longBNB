# longBNB

Month-to-month Airbnb stays, no deposit, calendar-first. Harvests Airbnb's
monthly-stay search + per-listing availability calendars, computes each
listing's "open runway," and serves a calendar UI where stays appear on the
day they open up.

## Features

- Calendar-first discovery (month / week / day) with a move-in-now hero
- Price-banded harvest so cheap inventory does not crowd out the rest
- Validated availability: each listing's Airbnb calendar is pulled, not guessed
- Map with hover tooltips and freehand "avoid" zones
- Dark mode, favorites, and swipeable photo carousels
- Optional 1-click OAuth (Google / GitHub / Apple); guest login otherwise
- Zero npm dependencies — Node 18+ is enough
- Daily background refresh with per-city freshness, restart catch-up, and a scheduled wake-up for the public Fly instance
- Follows Airbnb's advertised search pages and deduplicates listings across pages, dates, and price bands
- A natural-language finder for location, monthly budget, move-in date, stay length, and room type
- New York City coverage alongside San Francisco, Oakland, and Daly City

## Cities

New installations and the public hosted configuration track San Francisco,
Oakland, Daly City, and New York City (`New-York--NY`). NYC participates in
the same daily search and calendar refresh. The finder understands “NYC,”
“New York,” and “New York City.” “Bay Area” stays limited to the three Bay
Area cities; choose “all cities” to include New York too.

New York search results can include nearby New Jersey listings. LongBNB
keeps only results whose public map pins fall inside the five boroughs,
using [NYC Department of City Planning borough boundaries](https://data.cityofnewyork.us/City-Government/Borough-Boundaries/wh2p-dxnf)
(water areas included). `lib/nyc-boroughs.json` is a bundled snapshot of that
public GeoJSON, with coordinates rounded to six decimal places; there is no
runtime geocoding service or API fee. Pins are approximate, so confirm the
location on Airbnb. Listings without a usable NYC pin are excluded.

Deploy the updated hosted configuration to add NYC to an existing public
instance. Its first NYC refresh is due immediately even when the Bay Area
data is fresh. An existing standalone installation keeps its saved city
selection; add `New York, NY` with **+ city** to opt in. `CITIES` still replaces
the defaults for a new installation or hosted instance.

## Tech stack

As actually used (nothing else is required):

| Layer | What |
|---|---|
| Runtime | Node.js 18+ (`http`, `fs`, `crypto`, global `fetch`) |
| UI | Single-file `public/index.html` (vanilla JS) |
| Maps | Leaflet 1.9.4 + OpenStreetMap tiles (CDN) |
| Fonts | Bricolage Grotesque + IBM Plex Mono (Google Fonts) |
| Auth | HMAC-signed session cookies; OAuth via provider HTTP APIs |
| Persistence | JSON files under `DATA_DIR` (`listings.json`, `users.json`, `session.secret`) |
| Deploy | Dockerfile (`node:20-slim`) + Fly.io `fly.toml` |
| Harvest | Public Airbnb HTML search + `PdpAvailabilityCalendar` GraphQL |

There is no database, no frontend build, and no required paid AI service.

## Daily updates

The server checks every minute for cities last successfully refreshed at least
`REFRESH_HOURS` ago (24 by default), including on startup. Successful and failed
checks are recorded separately. Incomplete searches, broken calendars, or empty
results never erase previously good listings or mark those cities fresh.
Failed checks wait at least `REFRESH_RETRY_HOURS` (one hour by default) before retrying.
`/api/status` exposes per-city timestamps, stale state, the next due time, and any
last error. The interface shows when data needs a refresh.

An in-process timer cannot wake a suspended machine. For the existing public
instance at <https://longbnb.fly.dev>, `.github/workflows/daily-refresh.yml`
calls the authenticated streaming refresh endpoint each morning. Its two later
attempts are skipped once that day's refresh succeeds. The streaming response
keeps Fly awake until the job finishes. Requests share an existing harvest
instead of launching duplicates.

To activate the hosted schedule:

1. Deploy this revision with `fly deploy --config fly.hosted.toml` using access
   to the existing `longbnb` app. The configuration retains its suspended,
   single-machine design and existing `longbnb_data` volume; no new app or
   volume is needed.
2. Set the repository's `HARVEST_TOKEN` Actions secret to the **same existing
   secret** used by the Fly app. Never commit it. Optionally set repository
   variable `LONG_BNB_URL` when hosting at a different URL.
3. Merge the workflow onto the default branch, enable Actions schedules, and
   run “Refresh LongBNB listings” once from Actions. Verify the run succeeds and
   the public status endpoint has a recent success for every configured city.

The schedule runs at 13:17 UTC (06:17 Pacific daylight time / 05:17 Pacific
standard time), with retry opportunities at 14:17 and 15:17 UTC. GitHub can
delay scheduled jobs and disables schedules in public repositories after
60 days without activity; re-enable the workflow if that happens. A running
server's own timer and startup checks also catch up, but cannot wake an idle
Fly machine. Monitor Actions and the public freshness indicator.

The scraper covers the configured cities, date anchors, and monthly price bands.
It follows every returned page cursor (a 50-page safety ceiling is reported as
incomplete), rather than stopping at page one. Airbnb controls which inventory
it exposes; this cannot guarantee every Airbnb property or real-time availability.

## Find a place, without paid model calls

Type a request such as “A room in SF under $1,500 for 2 months,” or enter the
city, budget, dates, and duration directly. The finder returns actual cached
listings, cheapest first. Budget, city, room type, and minimum remaining stay
length are applied in code. Prices are monthly USD estimates; always confirm
fees, price and availability on Airbnb. An untracked city returns an explicit
coverage message instead of unrelated results.

Without a key, a small built-in parser handles the common requests with no
external AI call. To enable broader language interpretation, set
`OPENROUTER_API_KEY` on the server. The only model used is
[`openrouter/free`](https://openrouter.ai/docs/guides/routing/routers/free-router):
there is no selectable paid model or paid fallback. It receives the short
search request and available city names, not the listings, account data, or
chat history. Explicit form values and locally parsed budget/date constraints
take precedence over model output.

Free AI calls have a 12-second timeout, a 40-request daily application cap,
in-flight request deduplication, a bounded cache, and a cooldown after errors.
The finder falls back to its built-in parser on missing credentials, rate
limits, or outages. OpenRouter's own free limits still apply. The UI's free
search label concerns inference; hosting and network costs remain those of
the existing deployment.

## Run it locally

```bash
git clone <this-repo>
cd longbnb          # or whatever you named the checkout
cp .env.example .env   # optional — all vars have defaults
node server.js         # that's it — zero dependencies, Node 18+
```

Open http://localhost:3000. First boot auto-harvests (~5–15 min cold — it
searches every price band; cached re-runs are much faster); the
⟳ refresh button re-harvests on demand with live progress.

`server.js` loads a local `.env` if present (already-set env vars win). Do
not commit `.env`.

Example: `CITIES=Oakland--CA,Berkeley--CA node server.js`

## Environment variables

| var | default | meaning |
|---|---|---|
| `PORT` | `3000` | server port |
| `DATA_DIR` | `./data` | listings, users, and session secret |
| `CITIES` | `San-Francisco--CA,Oakland--CA,Daly-City--CA,New-York--NY` | comma-sep Airbnb city slugs |
| `PRICE_BANDS` | `0-1100,1100-1600,1600-2400,2400-3500,3500-5200,5200-` | disjoint $/mo search bands (trailing `-` = open top); each band is searched separately to beat Airbnb's ~20-results-per-page cap |
| `MAX_PRICE` | `0` (off) | optional global max $/month sanity cap |
| `WINDOW_DAYS` | `48` | runway must start within N days of today |
| `MIN_RUNWAY` | `28` | min contiguous open days to count |
| `CAL_TTL_HOURS` | `6` | calendar cache freshness |
| `SEARCH_TTL_HOURS` | `3` | search cache freshness (per city+band) |
| `REFRESH_HOURS` | `24` | maximum age before automatic per-city catch-up |
| `REFRESH_RETRY_HOURS` | `1` | minimum time between retry attempts |
| `HARVEST_DISABLED` | unset | `1` disables manual and scheduled downloads |
| `HOSTED` | unset | `1` enables public read-only browsing and local favorites; uses 20-hour search/calendar TTLs unless overridden |
| `HARVEST_TOKEN` | unset | bearer token required for administrative writes in hosted mode |
| `OPENROUTER_API_KEY` | unset | optional free-only language interpretation; never sent to the browser |
| `AIRBNB_API_KEY` | Airbnb's public web-client key | override if Airbnb rotates the client key |
| `CAL_HASH` | current `PdpAvailabilityCalendar` sha256 | override if calendars 404 (see Honest notes) |
| `SESSION_SECRET` | generated into `DATA_DIR/session.secret` | HMAC key for session cookies |
| `ALLOW_GUEST` | on when no OAuth provider is set | set `1` to keep guest login after configuring OAuth |
| `NODE_ENV` | unset | `production` marks cookies `Secure` (also set automatically on Fly via `FLY_APP_NAME`) |

See `.env.example` for the same list with comments.

### OAuth (optional)

Login is required. With no providers configured, a **guest login** button is shown.
Enable 1-click sign-in by setting provider keys (on Fly: `fly secrets set KEY=value`):

| Provider | Env vars | Callback URL to register |
|---|---|---|
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `https://<host>/auth/cb/google` |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `https://<host>/auth/cb/github` |
| Apple | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (.p8 contents) | `https://<host>/auth/cb/apple` |

Once any provider is set, guest login turns off automatically (re-enable with `ALLOW_GUEST=1`).
Sessions are HMAC-signed cookies (30 days); the secret persists in `DATA_DIR/session.secret`
(override with `SESSION_SECRET`). Favorites are saved per-user in `DATA_DIR/users.json`.

## Deploy (Fly.io)

Needs a **long-running Node process** (a cold harvest takes minutes —
serverless timeouts will kill it):

- **Railway / Render / Fly.io** — point at the repo, start command `node server.js`.
- **VPS** — `node server.js` behind nginx, or `pm2 start server.js`.
- **Not Vercel/Netlify functions** — the background harvest outlives their limits. (Vercel works only if you pre-commit `data/listings.json` and never refresh.)

Harvested data persists in `DATA_DIR/listings.json` — on hosts with ephemeral
disks it just re-harvests on boot.

### Fly.io (generic)

`fly.toml` ships with **placeholders**. Do not reuse someone else's live app name.

```bash
fly apps create your-longbnb-app          # pick your own unique name
# edit fly.toml: set `app` to that name, `primary_region` to yours
fly volumes create longbnb_data --region <your-region> --size 1
fly secrets set SESSION_SECRET="$(openssl rand -hex 32)"
# optional: fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
fly deploy
```

The `[mounts]` block maps volume `longbnb_data` → `/data` (`DATA_DIR=/data`).
Change `source` if you name the volume differently. Set `PORT=8080` (already in
`fly.toml`) so it matches `internal_port`.

## Honest notes

- This scrapes Airbnb (ToS-gray). Fine as a personal tool; cache aggressively,
  keep the delays in place, don't hammer.
- The calendar API's persisted-query hash can rotate when Airbnb ships. If
  calendars 404: open any airbnb.com listing page, search the HTML for
  `PdpAvailabilityCalendar`, copy the new sha256 hash into `CAL_HASH`.
- "Validated as of" = the harvest timestamp. Always recheck on Airbnb before
  committing money.

## Contributing

Issues and pull requests are welcome. Keep the zero-dependency, single-process
shape unless a change truly needs more. Before a PR:

- `node --check server.js`
- `node --test`
- Don't commit `.env`, `data/`, keys, or harvested listings
- Don't point `fly.toml` at a private live app

## License

[MIT](LICENSE) © 2026 Alex Newman
