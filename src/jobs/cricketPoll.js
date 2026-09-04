import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { matches } from "../db/schema.js";
import { fetchCurrentMatches, mapCricToMatch } from "../providers/cricketdata.js";
import { fetchCricbuzzScorecard, mapCricbuzzScorecard } from "../providers/cricbuzz.js";

// ponytail: global interval, per-match timer if quota grows
const POLL_MS = Number(process.env.CRICKETDATA_POLL_MS || 60 * 60 * 1000);
const SCORE_POLL_MS = Number(process.env.CRICBUZZ_POLL_MS || 2 * 60 * 60 * 1000);
const HARD_LIMIT = 100;
const SOFT_LIMIT = 90;
let interval = null;
let scoreInterval = null;
let running = false;
let scoreRunning = false;

async function syncOnce({ broadcastMatchCreated, broadcastScoreUpdate, broadcastScorecard } = {}) {
    if (running) return;
    running = true;
    try {
        const { data, info } = await fetchCurrentMatches();
        if (Number(info?.hitsToday) >= HARD_LIMIT) {
            console.warn(`[cricketPoll] hitsToday ${info.hitsToday}/${info.hitsLimit} — skipping sync`);
            return;
        }
        if (Number(info?.hitsToday) >= SOFT_LIMIT) console.warn(`[cricketPoll] soft limit ${info.hitsToday}/${info.hitsLimit}`);

        for (const cric of data) {
            const m = mapCricToMatch(cric);
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
                }).returning();
                console.log(`[cricketPoll] created ${created.id} ${m.homeTeam} vs ${m.awayTeam} ${m.homeScore}-${m.awayScore} ${m.status}`);
                if (broadcastMatchCreated) broadcastMatchCreated(created);
                if (broadcastScorecard && cric.score) broadcastScorecard(created.id, [{ score: m.homeScore, wickets: 0, overs: 0, batTeam: m.homeTeam }]);
            } else {
                const metaMissing = !row.metadata?.cricapi;
                const scoreChanged = row.homeScore !== m.homeScore || row.awayScore !== m.awayScore || row.status !== m.status || metaMissing || JSON.stringify(row.metadata?.cricapi?.score) !== JSON.stringify(cric.score);
                if (!scoreChanged) continue;
                const [updated] = await db.update(matches).set({
                    homeScore: m.homeScore,
                    awayScore: m.awayScore,
                    status: m.status,
                    startTime: m.startTime,
                    endTime: m.endTime,
                    metadata: meta,
                }).where(eq(matches.id, row.id)).returning();
                console.log(`[cricketPoll] score ${row.id} ${m.homeScore}-${m.awayScore} ${m.status}`);
                if (broadcastScoreUpdate) broadcastScoreUpdate(row.id, { homeScore: m.homeScore, awayScore: m.awayScore });
                if (broadcastScorecard) broadcastScorecard(row.id, cric.score);
            }
        }
        console.log(`[cricketPoll] synced ${data.length} matches, hitsToday ${info?.hitsToday}/${info?.hitsLimit}`);
    } catch (e) {
        console.error("[cricketPoll] sync error:", e.message);
    } finally {
        running = false;
    }
}

async function syncScorecards({ broadcastScorecard } = {}) {
    if (scoreRunning) return;
    scoreRunning = true;
    try {
        const liveRows = await db.select().from(matches).where(eq(matches.status, "live")).limit(2);
        for (const row of liveRows) {
            const cricId = row.externalId;
            if (!cricId || (cricId.includes("-") && cricId.length === 36)) continue; // cricketdata guid → no cricbuzz id
            try {
                const raw = await fetchCricbuzzScorecard(cricId);
                const scorecard = mapCricbuzzScorecard(raw);
                if (!scorecard.length) continue;
                const prev = row.metadata?.scorecard ? JSON.stringify(row.metadata.scorecard) : "";
                const next = JSON.stringify(scorecard);
                if (prev === next) continue;
                const newMeta = { ...(row.metadata || {}), scorecard, scorecardUpdatedAt: new Date().toISOString(), statusText: raw.status || null };
                const [updated] = await db.update(matches).set({ metadata: newMeta }).where(eq(matches.id, row.id)).returning();
                console.log(`[cricketPoll] scorecard ${row.id} updated`);
                if (broadcastScorecard) broadcastScorecard(row.id, scorecard);
            } catch (e) {
                console.warn(`[cricketPoll] scorecard ${cricId} skip: ${e.message}`);
            }
        }
    } catch (e) {
        console.warn("[cricketPoll] scorecard sync error:", e.message);
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
    console.log(`[cricketPoll] live list every ${POLL_MS}ms, scorecard every ${SCORE_POLL_MS}ms`);
    setTimeout(() => syncOnce(appLocals), 2000);
    setTimeout(() => syncScorecards(appLocals), 5000);
    interval = setInterval(() => syncOnce(appLocals), POLL_MS);
    scoreInterval = setInterval(() => syncScorecards(appLocals), SCORE_POLL_MS);
    return {
        stop() { if (interval) clearInterval(interval); if (scoreInterval) clearInterval(scoreInterval); interval = scoreInterval = null; },
        syncOnce: () => syncOnce(appLocals),
        syncScorecards: () => syncScorecards(appLocals),
    };
}

export function stopCricketPoll() {
    if (interval) clearInterval(interval);
    if (scoreInterval) clearInterval(scoreInterval);
    interval = scoreInterval = null;
}

// cli
if (process.argv.includes("--once")) {
    const key = process.env.CRICKETDATA_API_KEY || process.env.API_FOOTBALL_KEY || process.env.CRICBUZZ_API_KEY;
    if (!key) { console.error("CRICKETDATA_API_KEY missing"); process.exit(1); }
    const doScore = process.argv.includes("--scorecard");
    const fn = doScore ? syncScorecards : syncOnce;
    fn({}).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
