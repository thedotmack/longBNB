# Plan: Deploy longBNB to Fly.io

## Phase 0 — Documentation Discovery (COMPLETE)

Sources consulted:
- `fly.toml` (repo root) — app name is a placeholder (`your-longbnb-app`); set it to your own Fly app, region `sjc` (change as needed), `internal_port = 8080`, `PORT=8080` env, `auto_stop_machines='stop'`, `min_machines_running=0`
- `Dockerfile` — `node:20-slim`, `COPY . .`, `CMD ["node","server.js"]`
- `server.js:19` — `DATA_FILE = path.join(__dirname, "data", "listings.json")` (runtime cache location)
- `flyctl version` / `flyctl auth whoami` — confirm you are logged in to your own Fly account

Allowed APIs / commands (verified to exist in flyctl 0.4.x):
- `fly status -a <app>` · `fly apps list`
- `fly volumes create <name> --region sjc --size 1 -a <app>` · `fly volumes list -a <app>`
- `fly deploy` · `fly logs -a <app> --no-tail` · `fly machine restart <id>`
- fly.toml `[mounts]` block: `source = "<volume_name>"`, `destination = "/data"`

Anti-pattern guards:
- Do NOT invent fly.toml keys; only add the documented `[mounts]` block and an env var.
- Do NOT use `fly volumes create` flags other than `--region`, `--size`, `-a`, `--yes`.
- Volume names must match `^[a-z0-9_]+$` (no dashes).

## Phase 1 — Prep for persistent deploy (code + config)

What to implement (copy patterns, do not restructure):
1. `server.js`: make the data dir env-overridable — change line 19 area to
   `const DATA_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, "data"), "listings.json");`
   No other server changes.
2. Create `.dockerignore` with: `.git`, `data`, `plans`, `node_modules`, `.DS_Store`, `*.md`.
3. `fly.toml`: add `DATA_DIR = '/data'` to `[env]`, and append:
   ```toml
   [mounts]
     source = 'longbnb_data'
     destination = '/data'
   ```

Verification checklist:
- `node --check server.js` passes
- `grep -n "DATA_DIR" server.js fly.toml` shows both wired
- `DATA_DIR=/tmp/rwtest node server.js` boots and writes `/tmp/rwtest/listings.json` after harvest kicks (or boots clean; kill immediately — do not let a full harvest run)

Anti-pattern guards: don't touch harvest logic, endpoints, or the frontend.

## Phase 2 — Deploy

1. `fly status -a <your-app>` — determine if app exists; if not, `fly apps create <your-app>`.
2. `fly volumes list -a <your-app>` — create if missing:
   `fly volumes create longbnb_data --region sjc --size 1 -a <your-app> --yes`
3. `fly deploy` from repo root.

Verification checklist:
- `fly status` shows a started machine
- `curl https://<your-app>.fly.dev/api/status` returns JSON
- `curl .../api/listings` returns JSON (listings may be empty pre-harvest)
- `fly logs --no-tail` shows "longBNB on http://localhost:8080" and no crash loop

## Phase 3 — Final verification (persistence + behavior)

1. Wait for (or trigger) one harvest; confirm `/api/listings` non-empty or harvest progressing in logs.
2. `fly machine restart <id>`; after boot, `/api/listings` still returns prior data (volume works, no re-harvest storm — logs must NOT show "no cached data — starting first harvest" on second boot).
3. Commit + push all changes.

Anti-pattern guards: no scaling changes, no region changes, no extra services.
