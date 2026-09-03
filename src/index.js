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

// JSON middleware
app.use(express.json());

// CORS for frontend (vite on 3000/5173) — ponytail: no new dep, manual headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

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

const { broadcastMatchCreated, broadcastCommentary, broadcastScoreUpdate, getActiveMatchIds } = attachWebSocketServer(server);
app.locals.broadcastMatchCreated = broadcastMatchCreated;
app.locals.broadcastCommentary = broadcastCommentary;
app.locals.broadcastScoreUpdate = broadcastScoreUpdate;

// football live sync (polling) — only if key set, cached 60s
let footballPollTimer = null;
let eventsPollTimer = null;
if (process.env.API_FOOTBALL_KEY) {
  const { pollFootball, syncEventsForMatch } = await import("./services/apiFootball.js");
  const startPoll = () => {
    pollFootball({ broadcastMatchCreated, broadcastScoreUpdate }).catch((e) => console.error("pollFootball error:", e.message));
  };
  // initial sync after boot, then every 5 min to stay under 100/day
  setTimeout(startPoll, 5000);
  footballPollTimer = setInterval(startPoll, 5 * 60 * 1000);
  // events for watched matches only — ponytail: 45s interval, only if someone is watching
  eventsPollTimer = setInterval(() => {
    const ids = getActiveMatchIds();
    if (ids.length === 0) return;
    for (const id of ids) {
      syncEventsForMatch(id, broadcastCommentary).catch((e) => console.error("events poll error:", e.message));
    }
  }, 45 * 1000);
  console.log("API football polling enabled (5m interval, 60s cache) + events for watched matches (45s)");
} else {
  console.log("API_FOOTBALL_KEY not set — football live sync disabled");
}

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
