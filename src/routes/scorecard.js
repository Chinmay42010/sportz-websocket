import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { matches } from "../db/schema.js";
import { matchIdParamSchema } from "../validation/matches.js";

export const scorecardRouter = Router({ mergeParams: true });

scorecardRouter.get("/", async (req, res) => {
    const parsed = matchIdParamSchema.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid params.", details: parsed.error.issues });
    try {
        const rows = await db.select().from(matches).where(eq(matches.id, parsed.data.id)).limit(1);
        const row = rows[0];
        if (!row) return res.status(404).json({ error: "Match not found" });
        const scorecard = row.metadata?.scorecard || null;
        const cricapi = row.metadata?.cricapi || null;
        return res.json({ data: { scorecard, cricapi, metadata: row.metadata, homeScore: row.homeScore, awayScore: row.awayScore, status: row.status } });
    } catch (e) {
        return res.status(500).json({ error: "Failed to fetch scorecard", details: String(e.message) });
    }
});
