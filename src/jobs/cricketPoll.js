import "dotenv/config";
import { eq, like } from "drizzle-orm";
import { db } from "../db/db.js";
import { matches } from "../db/schema.js";
import { fetchCurrentMatches, mapCricToMatch } from "../providers/cricketdata.js";
import { fetchCricbuzzLiveMatches, parseCricbuzzLive, mapCricbuzzLiveToMatch, fetchCricbuzzScorecard, mapCricbuzzScorecard } from "../providers/cricbuzz.js";


const LIVE_POLL_MS = Number(process.env.CRICKETDATA_LIVE_POLL_MS || 5 * 60 * 1000);
const SCHEDULED_POLL_MS = Number(process.env.CRICKETDATA_POLL_MS || 60 * 60 * 1000);
const LIVE_SCORE_POLL_MS = Number(process.env.CRICBUZZ_LIVE_POLL_MS || 90 * 60 * 1000);
const SCHEDULED_SCORE_POLL_MS = Number(process.env.CRICBUZZ_POLL_MS || 2 * 60 * 60 * 1000);
const HARD_LIMIT = 100;
const SOFT_LIMIT = 90;
const RAPID_HARD = 16;
const RAPID_SOFT = 14;
let rapidHitsToday = 0;
let rapidDay = new Date().toDateString();
function incRapid(n = 1) {
    const today = new Date().toDateString();
    if (today !== rapidDay) { rapidDay = today; rapidHitsToday = 0; }
    rapidHitsToday += n;
    return rapidHitsToday;
}
export function isCricbuzzQuotaExhausted() {
    const today = new Date().toDateString();
    if (today !== rapidDay) { rapidDay = today; rapidHitsToday = 0; }
    return rapidHitsToday >= RAPID_HARD;
}
export function getRapidQuotaState() {
    const today = new Date().toDateString();
    if (today !== rapidDay) { rapidDay = today; rapidHitsToday = 0; }
    return { hitsToday: rapidHitsToday, hard: RAPID_HARD, soft: RAPID_SOFT, exhausted: rapidHitsToday >= RAPID_HARD, softExceeded: rapidHitsToday >= RAPID_SOFT };
}

let intervalLive = null;
let intervalScheduled = null;
let scoreLiveInterval = null;
let scoreScheduledInterval = null;
let running = false;
let scoreRunning = false;
const finishedSynced = new Set();
let lastScheduledPollAt = 0;
let lastCricbuzzSeedAt = 0;

function isFinishedDone(row) {
    return row.status === "finished" && finishedSynced.has(row.id);
}

async function syncOnce({ broadcastMatchCreated, broadcastScoreUpdate, broadcastScorecard } = {}) {
    if (running) return;
    running = true;
    const nowDate = new Date();
    try {
        // tier determination by DB live presence (bulk optimization)
        const liveProbe = await db.select().from(matches).where(eq(matches.status, "live")).limit(1);
        const hasLive = liveProbe.length > 0;
        const tier = hasLive ? "live" : "scheduled";
        const intervalMs = hasLive ? LIVE_POLL_MS : SCHEDULED_POLL_MS;
        console.log(`[cricketPoll] tier ${tier} polling every ${intervalMs}ms (live=${LIVE_POLL_MS}ms, scheduled=${SCHEDULED_POLL_MS}ms) hasLive=${hasLive}`);

        // scheduled throttling: if no live, skip if we polled too recently
        if (!hasLive && Date.now() - lastScheduledPollAt < SCHEDULED_POLL_MS) {
            const wait = SCHEDULED_POLL_MS - (Date.now() - lastScheduledPollAt);
            console.log(`[cricketPoll] tier scheduled — throttled, next in ${Math.ceil(wait / 1000)}s`);
            return;
        }

        const { data, info } = await fetchCurrentMatches();
        if (Number(info?.hitsToday) >= HARD_LIMIT) {
            console.warn(`[cricketPoll] hitsToday ${info.hitsToday}/${info.hitsLimit} — skipping sync (HARD ${HARD_LIMIT})`);
            return;
        }
        if (Number(info?.hitsToday) >= SOFT_LIMIT) console.warn(`[cricketPoll] soft limit ${info.hitsToday}/${info.hitsLimit} (SOFT ${SOFT_LIMIT})`);
        if (!hasLive) lastScheduledPollAt = Date.now();

        for (const cric of data) {
            const m = mapCricToMatch(cric);
            // finished: one final fetch then exclude
            const isFinishedIncoming = m.status === "finished";
            const existing = await db.select().from(matches).where(eq(matches.externalId, m.externalId)).limit(1);
            const row = existing[0];
            const meta = { cricapi: { score: cric.score, series_id: cric.series_id, matchType: cric.matchType, venue: cric.venue, statusText: cric.status } };
            if (!row) {
                const [created] = await db.insert(matches).values({
                    externalId: m.externalId,
                    sport: m.sport,
                    homeTeam: m.homeTeam,
                    awayTeam: m.awayTeam,
                    status: m.status,
                    startTime: m.startTime,
                    endTime: m.endTime,
                    homeScore: m.homeScore,
                    awayScore: m.awayScore,
                    metadata: meta,
                    lastSyncedAt: nowDate,
                }).returning();
                console.log(`[cricketPoll] created ${created.id} ${m.homeTeam} vs ${m.awayTeam} ${m.homeScore}-${m.awayScore} ${m.status} tier=${tier}`);
                if (isFinishedIncoming) finishedSynced.add(created.id);
                if (broadcastMatchCreated) broadcastMatchCreated(created);
                if (broadcastScorecard && cric.score) broadcastScorecard(created.id, { score: m.homeScore, wickets: 0, overs: 0, batTeam: m.homeTeam, lastSyncedAt: created.lastSyncedAt });
            } else {
                if (isFinishedDone(row)) continue;
                const metaMissing = !row.metadata?.cricapi;
                const scoreChanged = row.homeScore !== m.homeScore || row.awayScore !== m.awayScore || row.status !== m.status || metaMissing || JSON.stringify(row.metadata?.cricapi?.score) !== JSON.stringify(cric.score);
                // always update last_synced_at even if nothing changed (requirement #4)
                const [updated] = await db.update(matches).set({
                    homeScore: m.homeScore,
                    awayScore: m.awayScore,
                    status: m.status,
                    startTime: m.startTime,
                    endTime: m.endTime,
                    metadata: meta,
                    lastSyncedAt: nowDate,
                }).where(eq(matches.id, row.id)).returning();
                if (updated.status === "finished") finishedSynced.add(updated.id);
                if (!scoreChanged) {
                    console.log(`[cricketPoll] synced ${row.id} unchanged tier=${tier} lastSyncedAt=${nowDate.toISOString()}`);
                    continue;
                }
                console.log(`[cricketPoll] score ${row.id} ${m.homeScore}-${m.awayScore} ${m.status} tier=${tier}`);
                const stale = isCricbuzzQuotaExhausted();
                if (broadcastScoreUpdate) broadcastScoreUpdate(row.id, { homeScore: m.homeScore, awayScore: m.awayScore, lastSyncedAt: updated.lastSyncedAt, dataStale: stale });
                if (broadcastScorecard) broadcastScorecard(row.id, { scorecard: cric.score, lastSyncedAt: updated.lastSyncedAt, dataStale: stale });
            }
        }
        console.log(`[cricketPoll] synced ${data.length} matches, hitsToday ${info?.hitsToday}/${info?.hitsLimit} tier=${tier}`);

        // ponytail: also seed Cricbuzz live matches when RapidAPI key present (numeric ids enable scorecard) — gated to hasLive to avoid idle quota burn
        if (process.env.CRICBUZZ_API_KEY && process.env.CRICBUZZ_HOST) {
            try {
                if (!hasLive) {
                    console.log(`[cricketPoll] cricbuzz seed skipped — no live match (hasLive=false)`);
                } else if (Date.now() - lastCricbuzzSeedAt < LIVE_SCORE_POLL_MS) {
                    const wait = LIVE_SCORE_POLL_MS - (Date.now() - lastCricbuzzSeedAt);
                    console.log(`[cricketPoll] cricbuzz seed throttled — next in ${Math.ceil(wait / 60000)}m (interval ${LIVE_SCORE_POLL_MS / 60000}m)`);
                } else if (rapidHitsToday >= RAPID_HARD) {
                    console.warn(`[cricketPoll] cricbuzz rapid hitsToday ${rapidHitsToday}/${RAPID_HARD} — skipping live seed (quota exhausted, dataStale=true)`);
                } else {
                    lastCricbuzzSeedAt = Date.now();
                    incRapid(1);
                    if (rapidHitsToday >= RAPID_SOFT) console.warn(`[cricketPoll] cricbuzz soft limit ${rapidHitsToday}/${RAPID_HARD}`);
                    const liveJson = await fetchCricbuzzLiveMatches();
                    const liveList = parseCricbuzzLive(liveJson);
                    for (const c of liveList) {
                        const m = mapCricbuzzLiveToMatch(c);
                        const existing = await db.select().from(matches).where(eq(matches.externalId, m.externalId)).limit(1);
                        const row = existing[0];
                        const meta = { cricbuzz: c.raw, cricbuzzScore: c.score };
                        if (!row) {
                            const [created] = await db.insert(matches).values({
                                externalId: m.externalId,
                                sport: m.sport,
                                homeTeam: m.homeTeam,
                                awayTeam: m.awayTeam,
                                status: m.status,
                                startTime: m.startTime,
                                endTime: m.endTime,
                                homeScore: m.homeScore,
                                awayScore: m.awayScore,
                                metadata: meta,
                                lastSyncedAt: nowDate,
                            }).returning();
                            console.log(`[cricketPoll] cricbuzz created ${created.id} ${m.homeTeam} vs ${m.awayTeam} ${m.homeScore}-${m.awayScore} ${m.status} tier=${tier}`);
                            if (m.status === "finished") finishedSynced.add(created.id);
                            if (broadcastMatchCreated) broadcastMatchCreated(created);
                        } else {
                            if (isFinishedDone(row)) continue;
                            const changed = row.homeScore !== m.homeScore || row.awayScore !== m.awayScore || row.status !== m.status;
                            const [updated] = await db.update(matches).set({ homeScore: m.homeScore, awayScore: m.awayScore, status: m.status, metadata: meta, lastSyncedAt: nowDate }).where(eq(matches.id, row.id)).returning();
                            if (updated.status === "finished") finishedSynced.add(updated.id);
                            if (!changed) {
                                console.log(`[cricketPoll] cricbuzz synced ${row.id} unchanged tier=${tier}`);
                                continue;
                            }
                            console.log(`[cricketPoll] cricbuzz score ${row.id} ${m.homeScore}-${m.awayScore} tier=${tier}`);
                            if (broadcastScoreUpdate) broadcastScoreUpdate(row.id, { homeScore: m.homeScore, awayScore: m.awayScore, lastSyncedAt: updated.lastSyncedAt, dataStale: isCricbuzzQuotaExhausted() });
                        }
                    }
                    console.log(`[cricketPoll] cricbuzz synced ${liveList.length} live matches tier=${tier}`);
                }
            } catch (e) {
                console.warn(`[cricketPoll] cricbuzz live skip: ${e.message}`);
            }
        }
    } catch (e) {
        console.error("[cricketPoll] sync error:", e.message);
    } finally {
        running = false;
    }
}

async function syncScorecards({ broadcastScorecard, broadcastScoreUpdate } = {}) {
    if (scoreRunning) return;
    scoreRunning = true;
    try {
        const nowDate = new Date();
        const hits = incRapid(0);
        if (hits >= RAPID_HARD) {
            console.warn(`[cricketPoll] scorecard rapid hitsToday ${hits}/${RAPID_HARD} — skipping (HARD, dataStale=true)`);
            return;
        }
        if (hits >= RAPID_SOFT) console.warn(`[cricketPoll] scorecard soft limit ${hits}/${RAPID_HARD}`);

        // tiered: live first, scheduled second, finished excluded
        const tier = "live";
        console.log(`[cricketPoll] scorecard tier ${tier} every ${LIVE_SCORE_POLL_MS}ms (scheduled ${SCHEDULED_SCORE_POLL_MS}ms)`);
        // try cb-* live, then any live
        let rows = await db.select().from(matches).where(eq(matches.status, "live")).limit(5);
        // prioritize cb-* within live
        const cbLive = rows.filter(r => r.externalId?.startsWith("cb-")).slice(0, 2);
        let liveRows = cbLive.length ? cbLive : rows.slice(0, 2);
        // if no live rows, occasionally check scheduled (caller is live interval; scheduled interval handles scheduled)
        const isLiveInterval = true;
        let targets = liveRows;
        // filter finished
        targets = targets.filter(r => !isFinishedDone(r));
        for (const row of targets) {
            if (rapidHitsToday >= RAPID_HARD) { console.warn(`[cricketPoll] scorecard hard cap reached`); break; }
            let cricId = row.externalId;
            if (!cricId) continue;
            if (cricId.startsWith("cb-")) cricId = cricId.replace("cb-", "");
            if (cricId.includes("-") && cricId.length === 36) continue;
            try {
                incRapid(1);
                const raw = await fetchCricbuzzScorecard(cricId);
                const scorecard = mapCricbuzzScorecard(raw);
                if (!scorecard.length) {
                    await db.update(matches).set({ lastSyncedAt: nowDate }).where(eq(matches.id, row.id));
                    continue;
                }
                const prev = row.metadata?.scorecard ? JSON.stringify(row.metadata.scorecard) : "";
                const next = JSON.stringify(scorecard);
                const newMeta = { ...(row.metadata || {}), scorecard, scorecardUpdatedAt: new Date().toISOString(), statusText: raw.status || null };
                const [updated] = await db.update(matches).set({ metadata: newMeta, lastSyncedAt: nowDate }).where(eq(matches.id, row.id)).returning();
                if (prev === next) {
                    console.log(`[cricketPoll] scorecard ${row.id} unchanged tier=${tier} lastSyncedAt=${nowDate.toISOString()}`);
                    continue;
                }
                console.log(`[cricketPoll] scorecard ${row.id} updated tier=${tier}`);
                const stale2 = isCricbuzzQuotaExhausted();
                if (broadcastScorecard) broadcastScorecard(row.id, { scorecard, lastSyncedAt: updated.lastSyncedAt, dataStale: stale2 });
                // also push freshness via score_update without changing score
                if (broadcastScoreUpdate) broadcastScoreUpdate(row.id, { homeScore: updated.homeScore, awayScore: updated.awayScore, lastSyncedAt: updated.lastSyncedAt, dataStale: stale2 });
            } catch (e) {
                console.warn(`[cricketPoll] scorecard ${cricId} skip: ${e.message}`);
                // still mark synced to avoid tight retry loop on bad id
                try { await db.update(matches).set({ lastSyncedAt: nowDate }).where(eq(matches.id, row.id)); } catch {}
            }
        }
    } catch (e) {
        console.warn("[cricketPoll] scorecard sync error:", e.message);
    } finally {
        scoreRunning = false;
    }
}

async function syncScheduledScorecards(ctx) {
    if (scoreRunning) return;
    scoreRunning = true;
    try {
        const nowDate = new Date();
        console.log(`[cricketPoll] scorecard tier scheduled every ${SCHEDULED_SCORE_POLL_MS}ms`);
        const rows = await db.select().from(matches).where(eq(matches.status, "scheduled")).limit(2);
        const targets = rows.filter(r => !isFinishedDone(r));
        for (const row of targets) {
            if (rapidHitsToday >= RAPID_HARD) break;
            let cricId = row.externalId;
            if (!cricId) continue;
            if (cricId.startsWith("cb-")) cricId = cricId.replace("cb-", "");
            if (cricId.includes("-") && cricId.length === 36) continue;
            try {
                incRapid(1);
                const raw = await fetchCricbuzzScorecard(cricId);
                const scorecard = mapCricbuzzScorecard(raw);
                const newMeta = { ...(row.metadata || {}), scorecard, scorecardUpdatedAt: new Date().toISOString(), statusText: raw.status || null };
                await db.update(matches).set({ metadata: newMeta, lastSyncedAt: nowDate }).where(eq(matches.id, row.id));
                console.log(`[cricketPoll] scorecard scheduled ${row.id} synced`);
            } catch (e) {
                console.warn(`[cricketPoll] scorecard scheduled ${cricId} skip: ${e.message}`);
                try { await db.update(matches).set({ lastSyncedAt: nowDate }).where(eq(matches.id, row.id)); } catch {}
            }
        }
    } catch (e) {
        console.warn("[cricketPoll] scheduled scorecard error:", e.message);
    } finally {
        scoreRunning = false;
    }
}

export function startCricketPoll(appLocals = {}) {
    const hasKey = process.env.CRICKETDATA_API_KEY || process.env.API_FOOTBALL_KEY || process.env.CRICBUZZ_API_KEY;
    if (!hasKey) {
        console.warn("[cricketPoll] CRICKETDATA_API_KEY missing — polling disabled");
        return null;
    }
    const liveWindowMin = 7 * 60;
    const seedPerWindow = Math.ceil(liveWindowMin / (LIVE_SCORE_POLL_MS / 60000));
    const scorePerWindow = 2 * Math.ceil(liveWindowMin / (LIVE_SCORE_POLL_MS / 60000));
    const totalPerWindow = seedPerWindow + scorePerWindow;
    console.log(`[cricketPoll] tiered: live every ${LIVE_POLL_MS}ms (5m), scheduled every ${SCHEDULED_POLL_MS}ms (60m), scorecard live ${LIVE_SCORE_POLL_MS}ms (${LIVE_SCORE_POLL_MS/60000}m) / scheduled ${SCHEDULED_SCORE_POLL_MS}ms (${SCHEDULED_SCORE_POLL_MS/60000/60}h)`);
    console.log(`[cricketPoll] quota: CricAPI HARD ${HARD_LIMIT}/SOFT ${SOFT_LIMIT} per day (bulk 1 hit/poll), RapidAPI HARD ${RAPID_HARD}/SOFT ${RAPID_SOFT} per day (~500/month) — seed gated to hasLive & throttled to ${LIVE_SCORE_POLL_MS/60000}m`);
    console.log(`[cricketPoll] quota math (7h live window): seed ~${seedPerWindow} hits + scorecard ~${scorePerWindow} hits (batch 2) = ${totalPerWindow}/${RAPID_HARD} (${Math.round(totalPerWindow/RAPID_HARD*100)}% of HARD, ${Math.round(totalPerWindow/RAPID_SOFT*100)}% of SOFT) at ${LIVE_SCORE_POLL_MS/60000}m interval — idle days: 0 seed hits`);
    setTimeout(() => syncOnce(appLocals), 2000);
    setTimeout(() => syncScorecards(appLocals), 5000);
    intervalLive = setInterval(() => syncOnce(appLocals), LIVE_POLL_MS);
    // scheduled bulk is adaptive inside syncOnce; keep interval for explicit scheduled pass when no live
    intervalScheduled = setInterval(() => {
        // only run scheduled logic if no live matches (avoid double hit when live active)
        db.select().from(matches).where(eq(matches.status, "live")).limit(1).then(r => {
            if (r.length === 0) syncOnce(appLocals);
            else console.log(`[cricketPoll] tier scheduled — skipped, live active`);
        }).catch(() => syncOnce(appLocals));
    }, SCHEDULED_POLL_MS);
    scoreLiveInterval = setInterval(() => syncScorecards(appLocals), LIVE_SCORE_POLL_MS);
    scoreScheduledInterval = setInterval(() => syncScheduledScorecards(appLocals), SCHEDULED_SCORE_POLL_MS);
    return {
        stop() { if (intervalLive) clearInterval(intervalLive); if (intervalScheduled) clearInterval(intervalScheduled); if (scoreLiveInterval) clearInterval(scoreLiveInterval); if (scoreScheduledInterval) clearInterval(scoreScheduledInterval); intervalLive = intervalScheduled = scoreLiveInterval = scoreScheduledInterval = null; },
        syncOnce: () => syncOnce(appLocals),
        syncScorecards: () => syncScorecards(appLocals),
    };
}

export function stopCricketPoll() {
    if (intervalLive) clearInterval(intervalLive);
    if (intervalScheduled) clearInterval(intervalScheduled);
    if (scoreLiveInterval) clearInterval(scoreLiveInterval);
    if (scoreScheduledInterval) clearInterval(scoreScheduledInterval);
    intervalLive = intervalScheduled = scoreLiveInterval = scoreScheduledInterval = null;
}

// cli
if (process.argv.includes("--once")) {
    const key = process.env.CRICKETDATA_API_KEY || process.env.API_FOOTBALL_KEY || process.env.CRICBUZZ_API_KEY;
    if (!key) { console.error("CRICKETDATA_API_KEY missing"); process.exit(1); }
    const doScore = process.argv.includes("--scorecard");
    const fn = doScore ? syncScorecards : syncOnce;
    fn({}).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
