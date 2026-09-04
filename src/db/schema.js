import {
    pgEnum,
    pgTable,
    serial,
    text,
    integer,
    timestamp,
    jsonb,
} from "drizzle-orm/pg-core";

export const matchStatus = pgEnum("match_status", [
    "scheduled",
    "live",
    "finished",
]);

export const matches = pgTable("matches", {
    id: serial("id").primaryKey(),
    externalId: text("external_id").unique(),
    sport: text("sport").notNull(),
    homeTeam: text("home_team").notNull(),
    awayTeam: text("away_team").notNull(),
    status: matchStatus("status").default("scheduled").notNull(),
    startTime: timestamp("start_time"),
    endTime: timestamp("end_time"),
    homeScore: integer("home_score").default(0).notNull(),
    awayScore: integer("away_score").default(0).notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const commentary = pgTable("commentary", {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
        .notNull()
        .references(() => matches.id, { onDelete: "cascade" }),
    minute: integer("minute"),
    sequence: integer("sequence"),
    period: text("period"),
    eventType: text("event_type"),
    actor: text("actor"),
    team: text("team"),
    message: text("message"),
    metadata: jsonb("metadata"),
    tags: text("tags").array(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
