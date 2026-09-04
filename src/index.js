import AgentAPI from "apminsight";
AgentAPI.config();
import "dotenv/config";
import express from "express";
import http from "http";
import { matchRouter } from "./routes/matches.js";
import { attachWebSocketServer } from "./ws/server.js";
import { securityMiddleware } from "./arcjet.js";
import { commentaryRouter } from "./routes/commentary.js";

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
const server = http.createServer(app);

// ponytail: manual CORS locked to Vercel prod, allowlist/regex if previews needed
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "https://sportz-frontend-iota.vercel.app");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

// JSON middleware
app.use(express.json());

// Root route
app.get("/", (req, res) => {
    res.send("Hello from Express server");
});

// app.use(securityMiddleware());

app.use("/matches", matchRouter);
app.use("/matches/:id/commentary", commentaryRouter);

// global error handler so DB errors don't reset TCP
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error("Express error:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Internal Server Error" });
});

const { broadcastMatchCreated, broadcastCommentary, broadcastScoreUpdate } = attachWebSocketServer(server);
app.locals.broadcastMatchCreated = broadcastMatchCreated;
app.locals.broadcastCommentary = broadcastCommentary;
app.locals.broadcastScoreUpdate = broadcastScoreUpdate;

// ponytail: cricket live poll every 15m (100/day limit), disabled if CRICKETDATA_API_KEY missing
import { startCricketPoll } from "./jobs/cricketPoll.js";
const cricketPoll = startCricketPoll({ broadcastMatchCreated, broadcastScoreUpdate });

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.on("error", (err) => {
    console.error("HTTP server error:", err);
});

process.on("uncaughtException", (err) => {
    console.error("uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection:", reason);
});

server.listen(PORT, HOST, () => {
    const baseURl =
        HOST === "0.0.0.0"
            ? `http://localhost:${PORT}`
            : `http://${HOST}:${PORT}`;
    console.log(`Server running on ${baseURl}`);
    console.log(
        `WebSocket server is running on ${baseURl.replace("http", "ws")}/ws`,
    );
});

// 00:50:10
// 01:39:04
// 02:04:39
// 02:46:45
