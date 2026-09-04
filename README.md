# Sportz — Real-time Cricket Platform

> **Real time Sports data** • Live cricket scores, scorecard (batsman/bowler/overs), runs/wickets & commentary pushed over WebSocket.

Live: **Frontend** https://sportz-frontend-iota.vercel.app • **API** https://sportz-websocket-2wq7.onrender.com • **WS** `wss://sportz-websocket-2wq7.onrender.com/ws`

Monorepo split: `sportz-websocket` (this repo, Node/Express) + `sportz-frontend` (`Vite + React`, `../sportz-frontend`).

---

## Architecture

```
Vercel (Vite React) ── fetch/WS ──> Render (Express + ws on :8000, host 0.0.0.0)
                                          ├─ REST  /matches, /matches/:id/commentary, /matches/:id/scorecard
                                          ├─ WS    /ws  (pub/sub per matchId, heartbeat)
                                          ├─ Jobs  Current Matches (cricapi 1h) + Cricbuzz scorecard (2h)
                                          └─ DB    Neon Postgres (Drizzle ORM)
Providers: cricapi.com/v1/currentMatches (100/day) → totals r/w/o
           cricbuzz-cricket.p.rapidapi.com/mcenter/v1/{id}/hscard → batsman/bowler tables
```

Frontend `hooks/useMatchData.ts` fetches `GET /matches?limit=100` every `5s` + `GET /matches/:id/commentary` + `GET /matches/:id/scorecard` on `Watch Live`, subscribes via `hooks/useWebSocket.ts` (`type: subscribe`, `setSubscriptions`) and renders `components/MatchDetail.tsx` tabs **Match Data | Commentary** + `MatchCard.tsx` live pulse.

---

## Features

- **REST** — `GET /matches?limit`, `POST /matches` (Zod + `getMatchStatus`), `PATCH /matches/:id/score`, `GET/POST /matches/:id/commentary`, `GET /matches/:id/scorecard`.
- **Live** — `WS /ws` `attachWebSocketServer` with per-match `Map<matchId, Set<socket>>`, `subscribe / unsubscribe / setSubscriptions / ping → pong`, `broadcastMatchCreated` (all), `broadcastCommentary`/`broadcastScoreUpdate`/`broadcastScorecard` (per-match).
- **Polling** — `src/jobs/cricketPoll.js` `Current Matches` every `1h` (`24/day` fits `cricapi 100/day`) + `Cricbuzz hscard` every `2h` (`12/day` fits `RapidAPI 500/month`), soft `90` / hard `100` guard, dedup via `metadata` string compare, `metadata jsonb` on `matches` stores `{cricapi:{score}, scorecard:[{batting/bowling/fow}]}`.
- **UX** — `MatchData.tsx` neat innings tabs (`150/10 (18.5) 7.96` header, batting `R/B/4s/6s/SR` + `not out` dot, bowling `O-M-R-W Econ`, `extras/fow`), `LiveFeed.tsx` commentary timeline, `StatusIndicator` + `MatchCard` live red dot + pulse.

---

## Tech Stack & Tools

| Layer | Tool | Version | Purpose |
|-------|------|---------|---------|
| Runtime | **Node.js** | `>=18` | ESM (`"type":"module"`) |
| API | **Express** | `5.2.1` | REST, `app.use(express.json())` |
| WS | **ws** | `8.21.3` | `WebSocketServer({noServer:true, path:"/ws", maxPayload:1<<20})` |
| DB driver | **pg** | `8.23.0` | `Pool({max:10, keepAlive:true})` for Neon pooler |
| ORM | **drizzle-orm** | `0.45.2` | Typed queries, `eq`, `desc` |
| Migrations | **drizzle-kit** | `0.31.10` | `drizzle-kit generate/migrate`, `drizzle.config.js` |
| DB | **Neon Postgres** | — | Serverless Postgres, `sslmode=require` |
| Validation | **Zod** | `4.4.3` | `listMatchesQuerySchema`, `createMatchSchema` (iso datetime + `endTime>startTime`), `updateScoreSchema` |
| Security | **@arcjet/node** | `1.11.0` | Shield, bot detection, rate limiting (see below) |
| Inspector | **@arcjet/inspect** | `1.11.0` | Arcjet diagnostics |
| APM | **apminsight** | `5.5.1` | AppDynamics APM (`apmInsightNode.json`) |
| Env | **dotenv** | `17.4.2` | `import "dotenv/config"` |
| Providers | **CricAPI** `api.cricapi.com/v1` | `v1` | `currentMatches` totals |
| | **Cricbuzz Cricket** `RapidAPI` | `v1` | `matches/v1/live` + `mcenter/v1/{id}/hscard` full scorecard |
| Frontend | **Vite + React 19 + TypeScript** | `6.2 / 5.8` | `sportz-frontend` `App.tsx`, `useMatchData`, `MatchDetail` tabs |
| Deploy API | **Render** | — | `Detected service running on port 8000`, `AVAILABLE at https://sportz-websocket-2wq7.onrender.com` |
| Deploy UI | **Vercel** | — | `VITE_API_BASE_URL`, `VITE_WS_BASE_URL` build-time injected |
| Infra proxy | **Cloudflare** | — | `cf-ray`, `server: cloudflare` fronting Render |

---

## Backend Security

All security is **code-first, fail-closed** — missing `ARCJET_KEY` throws at boot (`src/arcjet.js:7`).

### 1. Arcjet — WAF / Bot / Rate Limit

| Where | Rules | Code | Behavior |
|-------|-------|------|----------|
| **HTTP** (`httpArcjet`) | `shield` + `detectBot(allow: SEARCH_ENGINE, PREVIEW)` + `slidingWindow 10s max 50` | `src/arcjet.js:9` `mode: LIVE` (or `DRY_RUN`) | `securityMiddleware()` `src/arcjet.js:37` → `protect(req)` → `429 Too many requests` or `403 Forbidden`, catch → `503` |
| **WS upgrade** (`wsArcjet`) | same `shield/detectBot` + `slidingWindow 2s max 5` (stricter — prevents WS flood) | `src/arcjet.js:23` | `server.on("upgrade")` `src/ws/server.js:134` → `await wsArcjet.protect(req)` → `socket.write("HTTP/1.1 429/403")` + `socket.destroy()` → never reaches `wss.handleUpgrade` |

`WS /ws` is **pre-handshake** gated: `if (!req.url.startsWith("/ws")) socket.destroy()` `src/ws/server.js:129`, only then `wss.handleUpgrade`.

### 2. Transport & Platform

- **CORS locked to prod** — `src/index.js:17` manual `Access-Control-Allow-Origin: https://sportz-frontend-iota.vercel.app` (not `*`), `Allow-Headers: Content-Type`, `Allow-Methods: GET,POST,PATCH,OPTIONS`, `OPTIONS → 204`. Fixes browser `Failed to fetch` cross-site (`sec-fetch-mode: cors`) while `WS wss://` bypasses CORS.
- **WS hardening** — `WebSocketServer({maxPayload: 1<<20})` `src/ws/server.js:122`, `ping 30s` + `isAlive` heartbeat `src/ws/server.js:185` (`ws.terminate()` if no `pong`), `readyState === OPEN` guard on every `send` `src/ws/server.js:32`, `maxPayload` + `invalid_json` guard `handleMessage` `src/ws/server.js:70`.
- **Render proxy** — `server.keepAliveTimeout=65000`, `headersTimeout=66000` `src/index.js:52` for Render/Cloudflare idle close, `HOST=0.0.0.0` `src/index.js:11`.

### 3. Input & Data Safety

- **Zod at trust boundary** — `src/validation/matches.js:3` `limit .max(100)`, `createMatchSchema` `z.iso.datetime` + `superRefine(end>start)`, `matchId .coerce.number().int().positive()`, `updateScoreSchema` non-negative; `src/validation/commentary.js:9` `message .min(1)`. `safeParse` → `400 {error, details}` never hits `db`.
- **SQL safety** — `Drizzle ORM` parameterized `db.select/insert/update` (`src/routes/matches.js:28`, `src/routes/commentary.js:26`) + `matches.externalId unique`, `matches.metadata jsonb` typed, `commentary.match_id fk cascade`; `.gitignore:68` ignores `.env`, migrations are versioned (`drizzle/meta/_journal.json`).
- **Pool hardening** — `pg Pool {max:10, idleTimeout 30s, connectionTimeout 10s, keepAlive:true}` `src/db/db.js:9` for Neon pooler, `pool.on("error")` log, `server.on("error")` + `process.on("uncaughtException/unhandledRejection")` `src/index.js:55` (never throws to client, returns `500 Internal Server Error` global handler `src/index.js:40`).
- **Provider quotas** — `src/jobs/cricketPoll.js:9` `HARD 100 / SOFT 90` for `cricapi` + `500/month` guard for `RapidAPI` (`rows limit 2` + `like "cb-%"` backfill), `hitsToday` check aborts poll, `JSON.stringify(prev)===next` dedup avoids churn + `WS` spam.
- **Secrets hygiene** — `dotenv` never committed, `API_FOOTBALL_KEY` dead (0 imports, delete on Render), live provider keys `CRICKETDATA_API_KEY=f0cd2b03…`, `CRICBUZZ_API_KEY=1f4a9e8c…` + `CRICBUZZ_HOST` are **server-only** `process.env` (never `VITE_` → never `chrome Sources`). Rotate via `cricketdata.org/member` / `RapidAPI default-application_12294402` if leaked (both keys were pasted in chat — free tier low risk but rotate for prod).

### 4. Observability

- **APM** — `AgentAPI.config()` `src/index.js:1` + `apmInsightNode.json:2` (`licenseKey`, `appName: sportz`).
- **Logs** — `Express error:` + `PG pool error:` + `WS upgrade error` + `[cricketPoll] created/score …` + `hitsToday/hitsLimit`.

---

## Installation

```bash
# backend
git clone https://github.com/Chinmay42010/sportz-websocket.git
cd sportz-websocket
npm install
cp .env.example .env   # or create .env (see below)
npm run db:generate    # after editing src/db/schema.js
npm run db:migrate     # applies drizzle/*.sql to DATABASE_URL (Neon)
npm run dev            # http://localhost:8000, ws://localhost:8000/ws
npm run seed           # API_URL=http://localhost:8000 node src/seed/seed.js  (uses src/data/data.json)
# jobs: node src/jobs/cricketPoll.js --once            (list 1 hit)
#       node src/jobs/cricketPoll.js --once --scorecard (detail 1 hit)

# frontend (separate repo)
git clone https://github.com/Chinmay42010/sportz-frontend sportz-frontend
cd sportz-frontend
npm install
echo 'VITE_API_BASE_URL=http://localhost:8000
VITE_WS_BASE_URL=ws://localhost:8000/ws' > .env
npm run dev            # http://localhost:5173
npm run build          # 220kB gzip 67kB
```

### Environment

**Backend `.env` (`src/index.js:11`, `src/db/db.js:5`, `src/arcjet.js:4`, `src/providers/*`)**

```
DATABASE_URL=postgresql://neondb_owner:...@ep-falling-frog-ax8uvilj-pooler.c-4.us-east-2.aws.neon.tech/neondb?sslmode=require
PORT=8000
HOST=0.0.0.0
ARCJET_KEY=ajkey_01m1...
ARCJET_ENV=production
ARCJET_MODE=LIVE
API_URL=https://sportz-websocket-2wq7.onrender.com
CRICKETDATA_API_KEY=f0cd2b03-9170-4c80-b224-0f4c7088155a   # cricapi currentMatches 100/day
CRICBUZZ_API_KEY=1f4a9e8c28msh5f6abe147064aaep12fd44jsnafc670d8f44d  # RapidAPI X-RapidAPI-Key
CRICBUZZ_HOST=cricbuzz-cricket.p.rapidapi.com
CRICKETDATA_POLL_MS=3600000    # 1h (optional, default 1h)
CRICBUZZ_POLL_MS=7200000       # 2h (optional, default 2h) — 12/day fits 500/month
```

**Frontend `.env` (`constants.ts:1`)**
```
VITE_API_BASE_URL=https://sportz-websocket-2wq7.onrender.com
VITE_WS_BASE_URL=wss://sportz-websocket-2wq7.onrender.com/ws
```

On **Render** add the same backend vars (`PORT` can be unset — Render injects `10000`, `HOST=0.0.0.0` mandatory). On **Vercel** add `VITE_*` then **Redeploy** (Vite injects at build).

---

## API Reference

| Method | Path | Validation | Description |
|--------|------|------------|-------------|
| `GET` | `/` | — | `Hello from Express server` `src/index.js:30` |
| `GET` | `/matches?limit=100` | `listMatchesQuerySchema` | `desc(createdAt)` up to `100` `src/routes/matches.js:16` |
| `POST` | `/matches` | `createMatchSchema` | auto `status=getMatchStatus(start,end)` `src/routes/matches.js:41` → `broadcastMatchCreated` |
| `PATCH` | `/matches/:id/score` | `matchId + updateScoreSchema` | `homeScore/awayScore` → `broadcastScoreUpdate` |
| `GET` | `/matches/:id/commentary?limit=100` | `listCommentaryQuerySchema` | `desc(createdAt)` `src/routes/commentary.js:12` |
| `POST` | `/matches/:id/commentary` | `createCommentarySchema` | → `broadcastCommentary` |
| `GET` | `/matches/:id/scorecard` | `matchId` | `row.metadata.scorecard` + `cricapi` `src/routes/scorecard.js:1` |

All errors: `400 {error, details}` (Zod), `404 Match not found`, `500 {error, details}`.

## WebSocket Protocol `wss://.../ws`

```
client → {type:"subscribe", matchId: 50}
client → {type:"unsubscribe", matchId: 50}
client → {type:"setSubscriptions", matchIds:[50,51]}   // ponytail: naive clear+re-add
client → {type:"ping"} → server {type:"pong"}
server → {type:"welcome"} on connect `src/ws/server.js:168`
server → {type:"subscribed", matchId}
server → {type:"commentary", data: Commentary}          // per-match
server → {type:"score_update", matchId, data:{homeScore,awayScore}}
server → {type:"scorecard", matchId, data: ScorecardInnings[]} // ponytail: metadata jsonb
server → {type:"match_created", data: Match}            // broadcastToAll
server → {type:"error", code:"invalid_json"|"invalid_matchId"}
```

Client `hooks/useWebSocket.ts:33` `connectGlobal()` with `?all=1` + exponential backoff `INITIAL 1s → MAX 30s`.

---

## Database

`src/db/schema.js:11` `pgEnum match_status {scheduled,live,finished}`

```sql
matches(id serial PK, external_id text UNIQUE, sport text, home_team text, away_team text,
        status match_status default 'scheduled', start_time timestamp, end_time timestamp,
        home_score int default 0, away_score int default 0, metadata jsonb, created_at timestamp)
commentary(id serial PK, match_id int FK → matches cascade, minute int, sequence int, period text,
           event_type text, actor text, team text, message text, metadata jsonb, tags text[], created_at timestamp)
```

`drizzle/0001_chemical_the_phantom.sql` `external_id` + `drizzle/0002_omniscient_thunderball.sql` `metadata` (stores `{scorecard:[{inningsId,batsman[],bowler[],score,wickets,overs}], cricapi:{score}}`).

---

## Deployment

- **Render** `sportz-websocket` — `Build: npm install`, `Start: node src/index.js`, env as above, health `GET /` `200`, logs show `WebSocket server is running on ws://.../ws` `src/index.js:74` + `[cricketPoll] starting every 3600000ms` `src/jobs/cricketPoll.js:12`.
- **Vercel** `sportz-frontend` — `VITE_*` set, push `main` auto-deploys (`09a77a2` `MatchData + MatchDetail tabs`).
- `npm run seed` against prod `API_URL` replays `src/data/data.json` via `fetchWithRetry` `src/seed/seed.js:46` (tolerant `ECONNRESET`).

---

## Security Checklist for Reviewers

- [ ] `ARCJET_KEY` is `LIVE` on prod, `DRY_RUN` only locally (`ARCJET_MODE`).
- [ ] `CORS` is **locked** to `https://sportz-frontend-iota.vercel.app` (`*` only for local `127.0.0.1` dev).
- [ ] No `VITE_` leaks of `CRICKETDATA/CRICBUZZ` keys — server-only `dotenv`.
- [ ] `Zod` `MAX_LIMIT 100` caps pagination; `external_id` unique prevents dup ingest.
- [ ] `WS maxPayload 1MB`, `ping/pong` 30s, `slidingWindow 2s/5` blocks flood before `handleUpgrade`.
- [ ] `metadata jsonb` is `jsonb` not `text` — no `JSON.parse` injection.

---

## Scripts

| Script | What |
|--------|------|
| `npm run dev` | `node --watch ./src/index.js` |
| `npm start` | `node src/index.js` (Render) |
| `npm run db:generate` | `drizzle-kit generate` |
| `npm run db:migrate` | `drizzle-kit migrate` |
| `npm run seed` | `node src/seed/seed.js` |

MIT • Built with `Express, ws, pg, drizzle-orm, Neon, Zod, Arcjet, apminsight, cricapi, RapidAPI` • Frontend `React + Vite` in `../sportz-frontend`.
