import { z } from "zod";

export const commentaryQuerySchema = z.object({
  limit: z.coerce.number().positive().max(100).optional(),
});

export const listCommentaryQuerySchema = commentaryQuerySchema;

export const createCommentarySchema = z.object({
  minute: z.coerce.number().int().nonnegative().optional(),
  minutes: z.coerce.number().int().nonnegative().optional(),
  sequence: z.coerce.number().int().nonnegative().optional(),
  period: z.string().optional(),
  eventType: z.string().optional(),
  actor: z.string().optional(),
  team: z.string().optional(),
  message: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});
