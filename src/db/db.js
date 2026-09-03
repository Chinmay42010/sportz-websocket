import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not defined");
}

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    // Neon pooler needs keepalive
    keepAlive: true,
});

pool.on("error", (err) => {
    console.error("PG pool error:", err.message);
});

export const db = drizzle(pool);
