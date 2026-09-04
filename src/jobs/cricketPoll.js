import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { matches } from "../db/schema.js";
import { fetchCurrentMatches, mapCricToMatch } from "../providers/cricketdata.js";

// ponytail: global interval, per-match timer if quota grows
const POLL_MS = Number(process.env.CRICKETDATA_POLL_MS || 15 * 60 * 1000);
const HARD_LIMIT = 100;
const SOFT_LIMIT = 90;
let interval = null;
let running = false;

async function syncOnce({ broadcastMatchCreated, broadcastScoreUpdate } = {}) {
    if (running) return;
    running = true;
    try {
        const { data, info } = await fetchCurrentMatches();
        if (Number(info?.hitsToday) >= HARD_LIMIT) {
            console.warn(`[cricketPoll] hitsToday ${info.hitsToday}/${info.hitsLimit} — skipping sync`);
            return;
        }
        if (Number(info?.hitsToday) >= SOFT_LIMIT) {
            console.warn(`[cricketPoll] soft limit ${info.hitsToday}/${info.hitsLimit} — syncing but next tick may skip`);
        }
        for (const cric of data) {
            const m = mapCricToMatch(cric);
            // lookup by externalId
            const existing = await db.select().from(matches).where(eq(matches.externalId, m.externalId)).limit(1);
            const row = existing[0];
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
                }).returning();
                console.log(`[cricketPoll] created ${created.id} ${m.homeTeam} vs ${m.awayTeam} ${m.homeScore}-${m.awayScore} ${m.status}`);
                if (broadcastMatchCreated) broadcastMatchCreated(created);
            } else {
                const scoreChanged = row.homeScore !== m.homeScore || row.awayScore !== m.awayScore;
                const statusChanged = row.status !== m.status;
                if (!scoreChanged && !statusChanged) continue;
                const [updated] = await db.update(matches).set({
                    homeScore: m.homeScore,
                    awayScore: m.awayScore,
                    status: m.status,
                    startTime: m.startTime,
                    endTime: m.endTime,
                }).where(eq(matches.id, row.id)).returning();
                if (scoreChanged) {
                    console.log(`[cricketPoll] score ${row.id} ${m.homeScore}-${m.awayScore}`);
                    if (broadcastScoreUpdate) broadcastScoreUpdate(row.id, { homeScore: m.homeScore, awayScore: m.awayScore });
                }
                if (statusChanged) console.log(`[cricketPoll] status ${row.id} ${row.status} -> ${m.status}`);
            }
        }
        console.log(`[cricketPoll] synced ${data.length} matches, hitsToday ${info?.hitsToday}/${info?.hitsLimit}`);
    } catch (e) {
        console.error("[cricketPoll] sync error:", e.message);
    } finally {
        running = false;
    }
}

export function startCricketPoll(appLocals = {}) {
    if (!process.env.CRICKETDATA_API_KEY && !process.env.API_FOOTBALL_KEY) {
        console.warn("[cricketPoll] CRICKETDATA_API_KEY missing — polling disabled");
        return null;
    }
    console.log(`[cricketPoll] starting every ${POLL_MS}ms`);
    // run once on boot after 2s to let DB connect
    setTimeout(() => syncOnce(appLocals), 2000);
    interval = setInterval(() => syncOnce(appLocals), POLL_MS);
    return {
        stop() { if (interval) clearInterval(interval); interval = null; },
        syncOnce: () => syncOnce(appLocals),
    };
}

export function stopCricketPoll() {
    if (interval) clearInterval(interval);
    interval = null;
}

// cli: node src/jobs/cricketPoll.js --once
if (process.argv.includes("--once")) {
    const key = process.env.CRICKETDATA_API_KEY || process.env.API_FOOTBALL_KEY;
    if (!key) { console.error("CRICKETDATA_API_KEY missing"); process.exit(1); }
    syncOnce({}).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
