# Sportz — Realtime Football Backend

Realtime football backend that syncs live fixtures from [API-Sports](https://api-sports.io) (football v3) and pushes `score_update` + `commentary` over WebSockets. Built with Express + WS + Drizzle + Neon Postgres. WS clients (any frontend) subscribe per match.

- **Run:** `http://localhost:8000` — REST `GET /matches`, `PATCH /matches/:id/score`, `GET/POST /matches/:id/commentary` — WS `ws://localhost:8000/ws`
- **Live source:** `https://v3.football.api-sports.io` — football only in this setup

---

## Description

Backend ingests live football without exposing the external API key. A 5-minute poller syncs `fixtures?live=all` (fallback `fixtures?date=today`), maps `fixture.status.short` → `scheduled|live|finished`, upserts into `matches`, and broadcasts `match_created` / `score_update` over WS. When a client subscribes to a match, a 45-second worker syncs `fixtures/events?fixture={extId}` → `commentary` rows → `broadcastCommentary` only to that match's subscribers.

- Live matches synced every **5 min**, in-memory cache **60s** to stay under API-Sports free tier 100 req/day.
- Commentary/events synced **only for watched matches** (`getActiveMatchIds().length > 0`) to avoid quota burn.
- CORS open for dev (`*`), keep-alive 65s, global error handler so DB errors don't drop TCP.

> Football only for now — other `api-sports` sports share same pattern, change `BASE` + `mapFixture`.

## Features

- **Matches**
  - `GET /matches?limit=1..100` — ordered `createdAt DESC` (`src/routes/matches.js:16`)
  - `POST /matches` — `zod` validation (`src/validation/matches.js:19` iso `startTime`/`endTime`, `endTime > startTime`) + `getMatchStatus` (`src/utils/match-status.js`)
  - `PATCH /matches/:id/score` — `updateScoreSchema` (`nonnegative int`) → `broadcastScoreUpdate` to subscribers of that match
  - `broadcastMatchCreated` to all WS clients on insert

- **Commentary**
  - `GET /matches/:id/commentary?limit=1..100` (`src/routes/commentary.js:12`)
  - `POST /matches/:id/commentary` — validates `minute/sequence/period/eventType/actor/team/message/metadata/tags` → `broadcastCommentary` to subscribers only
  - Live events mapped from `fixtures/events`: `minute = time.elapsed`, `eventType = type`, `actor = player.name`, `team = team.name`, `message = detail — actor (team)`, `metadata = raw event` (`src/db/schema.js:30`, `src/services/apiFootball.js:151`)

- **Realtime**
  - WS `subscribe`/`unsubscribe` + `setSubscriptions` (reconnect resync) — accepts `string|number` via `toMatchId` (`src/ws/server.js:62`)
  - `ping→pong`, 30s heartbeat (`ws.ping`/`isAlive`), `welcome`/`subscribed`/`subscriptions` flows
  - Message types: `welcome`, `subscribed`, `subscriptions`, `subscribed_all`, `score_update`, `commentary`, `pong`, `error`, `match_created`

- **External sync**
  - `src/services/apiFootball.js` — `apiFetch` (single header `x-apisports-key`, `GET` only, 10s abort, 60s cache), `mapFixture`, `mapStatus` (`1H→live`, `FT→finished`), `pollFootball`, `syncEventsForMatch`, `getExtIdForMatch`, `extIdByLocalId` deduped by `homeTeam|awayTeam` + 3h window + in-memory `seenEventKeys`

- **Ops**
  - CORS manual headers (`*`) (`src/index.js:20`)
  - `keepAliveTimeout 65s`, `headersTimeout 66s`, global error handler (`src/index.js:39`)
  - `HOST 0.0.0.0` `PORT 8000` (`src/index.js:11`)

## Security features

- **Arcjet** (`src/arcjet.js`, `@arcjet/node 1.11.0`, `@arcjet/inspect 1.11.0`)
  - `wsArcjet.protect(req)` on `upgrade` **before** `handleUpgrade` (`src/ws/server.js:128`) — denies with `429 Too Many Requests` (rate limit) or `403 Forbidden` (bot/spam) before handshake
  - Env `ARCJET_KEY`, `ARCJET_ENV` (`/.env:9-10`) — dev falls back to `127.0.0.1` (warn logged)
  - Scope: WS only (REST `securityMiddleware()` commented at `src/index.js:34` — enable when you add rate limit to `/matches`)
- **Input validation** (`zod 4.4.3`)
  - `listMatchesQuerySchema`, `matchIdParamSchema`, `createMatchSchema` (`iso datetime`, `endTime > startTime`), `updateScoreSchema` (`nonnegative int`) — all routes return `400` with `details` on fail
- **WS hardening**
  - `maxPayload 1MB` (`src/ws/server.js:125`), JSON parse guard → `error {code: invalid_json}`, `toMatchId` rejects non-integers → `error {code: invalid_matchId}`
  - `readyState === OPEN` checks before `send`, `terminate` on `error`, `cleanupSubscriptions` on `close`, `matchSubscribers` map per `matchId`
- **Transport / DB**
  - HTTP keep-alive/headers timeout guards, `unhandledRejection`/`uncaughtException` log (no crash)
  - Neon `pg` pool `keepAlive: true`, `max:10`, `idleTimeout 30s` (`src/db/db.js:13`) — avoids reset behind pooler

> To tighten for prod: uncomment `app.use(securityMiddleware())`, add `helmet`, restrict `Access-Control-Allow-Origin` from `*` to your client URL, set `ARCJET_ENV=production`, rotate `API_FOOTBALL_KEY`, set `sslmode=verify-full` on `DATABASE_URL`.

## Tools used — purpose

| Tool | Version | Purpose | Where |
|---|---|---|---|
| **express** | 5.2.1 | REST (`/matches`, `/matches/:id/commentary`, `PATCH /:id/score`) | `src/index.js:6`, `src/routes/*` |
| **ws** | 8.21.3 | WS server (`/ws`, pub/sub per match, heartbeat) | `src/ws/server.js:1` |
| **drizzle-orm** | 0.45.2 | Typesafe SQL (`eq`, `desc`, `and`) + schema | `src/db/schema.js`, `src/routes/*`, `src/services/apiFootball.js` |
| **drizzle-kit** | 0.31.10 | `db:generate` / `db:migrate` | `package.json:9` |
| **pg** | 8.23.0 | Postgres driver + pool (Neon) | `src/db/db.js:3` |
| **zod** | 4.4.3 | Request validation (matches/commentary) | `src/validation/*` |
| **@arcjet/node** + **@arcjet/inspect** | 1.11.0 | Rate limit / bot protection on WS upgrade | `src/arcjet.js`, `src/ws/server.js:128` |
| **dotenv** | 17.4.2 | `DATABASE_URL`, `PORT`, `ARCJET_KEY`, `API_FOOTBALL_KEY` | `src/index.js:3`, `src/services/apiFootball.js` |
| **apminsight** | 5.5.1 | APM — `AgentAPI.config()` at boot | `src/index.js:1` |
| **API-Sports** | football v3 | External live fixtures + events | `src/services/apiFootball.js:5` |

## Flow diagram

```mermaid
flowchart TB
  API[API-Sports<br/>v3.football.api-sports.io<br/>fixtures live=all → today<br/>fixtures/events?fixture=extId]

  subgraph Backend [Sportz Backend — Express + WS — :8000<br/>src/index.js]
    Poll[Poller<br/>src/services/apiFootball.js<br/>pollFootball 5m + cache 60s<br/>mapFixture / mapStatus]
    Evt[Events worker<br/>syncEventsForMatch 45s<br/>only if getActiveMatchIds()>0<br/>seenEventKeys dedupe]
    REST[REST<br/>GET /matches?limit<br/>POST /matches<br/>PATCH /:id/score → broadcastScoreUpdate<br/>GET/POST /:id/commentary → broadcastCommentary]
    WS[WS /ws<br/>src/ws/server.js<br/>subscribe / unsubscribe<br/>setSubscriptions<br/>ping→pong<br/>heartbeat 30s]
    Gate{{Arcjet<br/>wsArcjet.protect on upgrade<br/>429 / 403 before handshake}}
    DB[(Postgres Neon<br/>drizzle-orm pg<br/>matches id sport homeTeam awayTeam status startTime homeScore awayScore<br/>commentary id matchId minute eventType actor team message metadata)]
  end

  Client([WS + REST Client<br/>curl / any frontend])

  Client -- "GET /matches?limit=100<br/>GET /matches/:id/commentary<br/>POST /matches/:id/commentary<br/>PATCH /:id/score" --> REST
  Client -- "WS upgrade /ws<br/>subscribe {matchId}<br/>setSubscriptions [ids]<br/>ping" --> Gate --> WS
  WS -- "welcome<br/>subscribed {matchId}<br/>subscriptions [ids]<br/>score_update {matchId, homeScore, awayScore}<br/>commentary {data}<br/>pong / error" --> Client
  REST <--> DB
  WS <--> DB

  Poll -- "GET fixtures?live=all<br/>x-apisports-key: API_FOOTBALL_KEY<br/>fallback date=today" --> API
  Poll --> DB
  Poll -- "broadcastMatchCreated<br/>broadcastScoreUpdate" --> WS

  Evt -- "GET fixtures/events?fixture=extId<br/>extIdByLocalId map<br/>homeTeam|awayTeam 3h dedupe" --> API
  Evt --> DB
  Evt -- "broadcastCommentary" --> WS

  classDef ext fill:#0a1e3d,stroke:#0a1e3d,color:#fff
  classDef be fill:#fff,stroke:#0a1e3d,stroke-width:2px
  class API ext
  class Poll,Evt,REST,WS,DB,Gate be
```

## Quick start

```bash
cd Sportz
# .env requires DATABASE_URL, PORT=8000, ARCJET_KEY, API_FOOTBALL_KEY
npm install
npm run db:migrate   # if fresh Neon DB
npm run dev          # watch src/index.js → http://localhost:8000  ws://localhost:8000/ws

# verify
curl http://localhost:8000/matches?limit=1
curl http://localhost:8000/matches/1/commentary?limit=5
# WS
# wscat -c ws://localhost:8000/ws
# > {"type":"subscribe","matchId":1}
# < {"type":"subscribed","matchId":1}
# < {"type":"score_update","matchId":1,"data":{"homeScore":1,"awayScore":0}}
```

## Env

```
DATABASE_URL=postgresql://.../neondb?sslmode=require  # Neon, keepAlive true in src/db/db.js:13
PORT=8000
HOST=0.0.0.0
ARCJET_KEY=ajkey_...
ARCJET_ENV=development
API_URL=http://localhost:8000
API_FOOTBALL_KEY=...                 # football v3 key — header x-apisports-key
API_FOOTBALL_BASE=https://v3.football.api-sports.io  # optional override
```

## Notes

- Free tier API-Sports: 100 req/day — `pollFootball` 5 min + `apiFetch` cache 60s + `syncEventsForMatch` only for `getActiveMatchIds()` avoids burn. `live=all` empty off-hours → polls `date=today` (first 20).
- `matchSubscribers` (`Map<matchId, Set<socket>>`) + `socket.subscriptions` (`Set`) + `toMatchId` coercion accepts `string|number` (`src/ws/server.js:62`).
- DB `matches.status` enum `scheduled|live|finished` (`src/db/schema.js:11`), `commentary` cascade delete on match.
- CORS `*` is dev-only — restrict in prod.

---

*Backend only — Express/WS + Drizzle/pg + Arcjet + API-Sports football v3. See `src/index.js`, `src/ws/server.js`, `src/services/apiFootball.js`.*
