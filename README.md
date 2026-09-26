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

There is no database, no frontend build, and no Stripe / Supabase / Resend / OpenAI.

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
| `CITIES` | `San-Francisco--CA,Oakland--CA,Daly-City--CA` | comma-sep Airbnb city slugs |
| `PRICE_BANDS` | `0-1100,1100-1600,1600-2400,2400-3500,3500-5200,5200-` | disjoint $/mo search bands (trailing `-` = open top); each band is searched separately to beat Airbnb's ~20-results-per-page cap |
| `MAX_PRICE` | `0` (off) | optional global max $/month sanity cap |
| `WINDOW_DAYS` | `48` | runway must start within N days of today |
| `MIN_RUNWAY` | `28` | min contiguous open days to count |
| `CAL_TTL_HOURS` | `6` | calendar cache freshness |
| `SEARCH_TTL_HOURS` | `3` | search cache freshness (per city+band) |
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
- Don't commit `.env`, `data/`, keys, or harvested listings
- Don't point `fly.toml` at a private live app

## License

[MIT](LICENSE) © 2026 Alex Newman
