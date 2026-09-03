import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { commentary } from "../db/schema.js";
import { matchIdParamSchema } from "../validation/matches.js";
import { createCommentarySchema, listCommentaryQuerySchema } from "../validation/commentary.js";

export const commentaryRouter = Router({ mergeParams: true });

const MAX_LIMIT = 100;

commentaryRouter.get("/", async (req, res) => {
    const parsedParams = matchIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
        return res.status(400).json({ error: "Invalid params.", details: parsedParams.error.issues });
    }

    const parsedQuery = listCommentaryQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
        return res.status(400).json({ error: "Invalid query.", details: parsedQuery.error.issues });
    }

    const limit = Math.min(parsedQuery.data.limit ?? 100, MAX_LIMIT);

    try {
        const data = await db
            .select()
            .from(commentary)
            .where(eq(commentary.matchId, parsedParams.data.id))
            .orderBy(desc(commentary.createdAt))
            .limit(limit);

        return res.json({ data });
    } catch (e) {
        return res.status(500).json({ error: "Failed to fetch commentary", details: JSON.stringify(e) });
    }
});

commentaryRouter.post("/", async (req, res) => {
    const parsedParams = matchIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
        return res
            .status(400)
            .json({
                error: "Invalid params.",
                details: parsedParams.error.issues,
            });
    }

    const parsedBody = createCommentarySchema.safeParse(req.body);
    if (!parsedBody.success) {
        return res
            .status(400)
            .json({
                error: "Invalid payload.",
                details: parsedBody.error.issues,
            });
    }

    try {
        const {
            minute,
            minutes,
            sequence,
            period,
            eventType,
            actor,
            team,
            message,
            metadata,
            tags,
        } = parsedBody.data;

        const [row] = await db.insert(commentary).values({
                matchId: parsedParams.data.id,
                minute: minute ?? minutes ?? null,
                sequence: sequence ?? null,
                period: period ?? null,
                eventType: eventType ?? null,
                actor: actor ?? null,
                team: team ?? null,
                message,
                metadata: metadata ?? null,
                tags: tags ?? null,
            }).returning();

            if(res.app.locals.broadcastCommentary) {
                res.app.locals.broadcastCommentary(row.matchId, row);
            }

        return res.status(201).json({ data: row });
    } catch (e) {
        return res
            .status(500)
            .json({
                error: "Failed to create commentary",
                details: JSON.stringify(e),
            });
    }
});
