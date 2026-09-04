import { Router } from "express";
import {
    createMatchSchema,
    listMatchesQuerySchema,
    matchIdParamSchema,
    updateScoreSchema,
} from "../validation/matches.js";
import { matches } from "../db/schema.js";
import { getMatchStatus } from "../utils/match-status.js";
import { db } from "../db/db.js";
import { desc, eq } from "drizzle-orm";
import { isCricbuzzQuotaExhausted } from "../jobs/cricketPoll.js";

export const matchRouter = Router();

const MAX_LIMIT = 100;
matchRouter.get("/", async (req, res) => {
    const parsed = listMatchesQuerySchema.safeParse(req.query);

    if (!parsed.success) {
        return res.status(400).json({
            error: "Invalid query.",
            details: parsed.error.issues,
        });
    }

    const limit = Math.min(parsed.data.limit ?? 50, MAX_LIMIT);

    try {
        const rows = await db
            .select()
            .from(matches)
            .orderBy(desc(matches.createdAt))
            .limit(limit);
        const dataStale = isCricbuzzQuotaExhausted();
        const data = rows.map(r => ({ ...r, dataStale }));
        res.json({ data, meta: { dataStale } });
    } catch (error) {
        res.status(500).json({ error: "Failed to list matches" });
    }
});

matchRouter.post("/", async (req, res) => {
    const parsed = createMatchSchema.safeParse(req.body);

    if (!parsed.success) {
        return res
            .status(400)
            .json({ error: "Invalid Payload.", details: parsed.error.issues });
    }

    const {
        data: { startTime, endTime, homeScore, awayScore },
    } = parsed;

    try {
        const [event] = await db
            .insert(matches)
            .values({
                ...parsed.data,
                startTime: new Date(parsed.data.startTime),
                endTime: new Date(parsed.data.endTime),
                homeScore: homeScore ?? 0,
                awayScore: awayScore ?? 0,
                status: getMatchStatus(startTime, endTime),
            })
            .returning();

        if (res.app.locals.broadcastMatchCreated) {
            res.app.locals.broadcastMatchCreated(event);
        }

        res.status(201).json({ data: event });
    } catch (e) {
        res.status(500).json({
            error: "Failed to create match",
            details: JSON.stringify(e),
        });
    }
});

matchRouter.patch("/:id/score", async (req, res) => {
    const parsedParams = matchIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
        return res.status(400).json({ error: "Invalid params.", details: parsedParams.error.issues });
    }
    const parsedBody = updateScoreSchema.safeParse(req.body);
    if (!parsedBody.success) {
        return res.status(400).json({ error: "Invalid payload.", details: parsedBody.error.issues });
    }
    try {
        const [updated] = await db.update(matches).set({
            homeScore: parsedBody.data.homeScore,
            awayScore: parsedBody.data.awayScore,
            lastSyncedAt: new Date(),
        }).where(eq(matches.id, parsedParams.data.id)).returning();
        if (!updated) return res.status(404).json({ error: "Match not found" });
        if (res.app.locals.broadcastScoreUpdate) {
            res.app.locals.broadcastScoreUpdate(updated.id, { homeScore: updated.homeScore, awayScore: updated.awayScore, lastSyncedAt: updated.lastSyncedAt });
        }
        res.json({ data: updated });
    } catch (e) {
        res.status(500).json({ error: "Failed to update score", details: JSON.stringify(e) });
    }
});
