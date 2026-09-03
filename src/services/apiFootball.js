import { matches, commentary } from "../db/schema.js";
import { db } from "../db/db.js";
import { eq, and } from "drizzle-orm";

const BASE = process.env.API_FOOTBALL_BASE || "https://v3.football.api-sports.io";
// ponytail: naive in-memory cache, 60s ttl fine for 100 req/day limit
const cache = new Map();
// localMatchId -> extFixtureId for event sync
const extIdByLocalId = new Map();
// commentary dedupe in memory to avoid DB roundtrip
const seenEventKeys = new Set();

function mapStatus(short) {
  if (!short) return "scheduled";
  const s = String(short).toUpperCase();
  if (["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT"].includes(s)) return "live";
  if (["FT", "AET", "PEN", "AWD", "WO"].includes(s)) return "finished";
  // PST, CANC, ABD, NS etc → scheduled
  return "scheduled";
}

export function mapFixture(f) {
  const home = f.teams?.home?.name ?? "Home";
  const away = f.teams?.away?.name ?? "Away";
  const date = f.fixture?.date ? new Date(f.fixture.date) : new Date();
  const status = mapStatus(f.fixture?.status?.short);
  const homeScore = f.goals?.home ?? 0;
  const awayScore = f.goals?.away ?? 0;
  return {
    sport: "football",
    homeTeam: home,
    awayTeam: away,
    status,
    startTime: date,
    homeScore: Number.isFinite(homeScore) ? homeScore : 0,
    awayScore: Number.isFinite(awayScore) ? awayScore : 0,
    _extId: f.fixture?.id,
    _league: f.league?.name,
  };
}

export async function apiFetch(endpoint, params = {}) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error("API_FOOTBALL_KEY missing");
  const cacheKey = `${endpoint}:${JSON.stringify(params)}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < 60_000) return hit.data;

  const url = new URL(`${BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { "x-apisports-key": key },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`api-football ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    cache.set(cacheKey, { data, ts: Date.now() });
    return data;
  } finally {
    clearTimeout(t);
  }
}

export async function pollFootball({ broadcastMatchCreated, broadcastScoreUpdate } = {}) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    console.log("API_FOOTBALL_KEY not set — skipping football poll");
    return { fetched: 0, upserts: 0 };
  }

  let fixtures = [];
  try {
    // ponytail: try live first, fallback to today — 2 calls max
    const live = await apiFetch("fixtures", { live: "all" });
    fixtures = Array.isArray(live.response) ? live.response : [];
    if (fixtures.length === 0) {
      const today = new Date().toISOString().slice(0, 10);
      const day = await apiFetch("fixtures", { date: today });
      fixtures = Array.isArray(day.response) ? day.response.slice(0, 20) : [];
    }
  } catch (e) {
    console.error("api-football poll failed:", e.message);
    return { fetched: 0, upserts: 0, error: e.message };
  }

  if (fixtures.length === 0) {
    console.log("api-football: no fixtures to sync");
    return { fetched: 0, upserts: 0 };
  }

  // limit to avoid DB spam on free tier
  const slice = fixtures.slice(0, 20);
  let upserts = 0;

  // build key map for existing matches to avoid dup
  const existing = await db.select().from(matches).limit(100);
  const byKey = new Map(existing.map((m) => [`${m.homeTeam}|${m.awayTeam}`, m]));

  for (const f of slice) {
    const mapped = mapFixture(f);
    const key = `${mapped.homeTeam}|${mapped.awayTeam}`;
    const found = byKey.get(key);

    // check if same fixture already within 3h window to avoid dup on same teams diff day
    const sameDay = found && Math.abs(new Date(found.startTime).getTime() - mapped.startTime.getTime()) < 3 * 3600 * 1000;

    if (found && sameDay) {
      extIdByLocalId.set(found.id, mapped._extId);
      const scoreChanged = found.homeScore !== mapped.homeScore || found.awayScore !== mapped.awayScore || found.status !== mapped.status;
      if (scoreChanged) {
        const [updated] = await db
          .update(matches)
          .set({ homeScore: mapped.homeScore, awayScore: mapped.awayScore, status: mapped.status, startTime: mapped.startTime })
          .where(eq(matches.id, found.id))
          .returning();
        if (updated && broadcastScoreUpdate && (found.homeScore !== mapped.homeScore || found.awayScore !== mapped.awayScore)) {
          broadcastScoreUpdate(updated.id, { homeScore: updated.homeScore, awayScore: updated.awayScore });
        }
        upserts++;
      }
    } else {
      try {
        const [created] = await db
          .insert(matches)
          .values({
            sport: mapped.sport,
            homeTeam: mapped.homeTeam,
            awayTeam: mapped.awayTeam,
            status: mapped.status,
            startTime: mapped.startTime,
            endTime: null,
            homeScore: mapped.homeScore,
            awayScore: mapped.awayScore,
          })
          .returning();
        if (created) {
          extIdByLocalId.set(created.id, mapped._extId);
          if (broadcastMatchCreated) broadcastMatchCreated(created);
        }
        upserts++;
        byKey.set(key, created);
      } catch (e) {
        console.error("insert fixture failed:", e.message);
      }
    }
  }

  console.log(`api-football sync: fetched ${slice.length}, upserts ${upserts}`);
  return { fetched: slice.length, upserts };
}

export function getExtIdForMatch(localId) {
  return extIdByLocalId.get(Number(localId)) ?? null;
}

export async function syncEventsForMatch(localId, broadcastCommentary) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return { fetched: 0, inserted: 0 };
  const extId = getExtIdForMatch(localId);
  if (!extId) return { fetched: 0, inserted: 0, error: "no extId" };

  let events = [];
  try {
    const data = await apiFetch("fixtures/events", { fixture: extId });
    events = Array.isArray(data.response) ? data.response : [];
  } catch (e) {
    console.error(`events poll ${localId}/${extId} failed:`, e.message);
    return { fetched: 0, inserted: 0, error: e.message };
  }

  let inserted = 0;
  for (const ev of events) {
    const minute = ev.time?.elapsed ?? null;
    const eventType = (ev.type || "update").toString().toLowerCase();
    const actor = ev.player?.name || null;
    const team = ev.team?.name || null;
    const detail = ev.detail || ev.type || "";
    const message = detail ? `${detail}${actor ? ` — ${actor}` : ""}${team ? ` (${team})` : ""}` : (ev.comments || "Update");
    const dedupeKey = `${localId}|${minute}|${eventType}|${actor}|${team}|${message}`;
    if (seenEventKeys.has(dedupeKey)) continue;

    // DB dedupe check (cheap — small table)
    // ponytail: no unique constraint, check existence via query then insert
    try {
      const [row] = await db
        .insert(commentary)
        .values({
          matchId: Number(localId),
          minute: Number.isFinite(minute) ? minute : null,
          sequence: null,
          period: ev.time?.extra ? `+${ev.time.extra}` : null,
          eventType,
          actor,
          team,
          message,
          metadata: ev,
          tags: null,
        })
        .returning();
      seenEventKeys.add(dedupeKey);
      inserted++;
      if (broadcastCommentary) broadcastCommentary(Number(localId), row);
    } catch (e) {
      // ignore dup FK errors (match deleted)
      if (!String(e.message).includes("foreign key")) console.error("insert commentary failed:", e.message);
    }
  }
  if (inserted > 0) console.log(`events sync match ${localId} (${extId}): +${inserted} commentary`);
  return { fetched: events.length, inserted };
}
