import express from "express";
import http from "http";
import { matchRouter } from "./routes/matches.js";
import { attachWebSocketServer } from "./ws/server.js";

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
const server = http.createServer(app);

// JSON middleware
app.use(express.json());

// Root route
app.get("/", (req, res) => {
  res.json({ message: "Hello from Express server" });
});

app.use("/matches", matchRouter);

const { broadcastMatchCreated } = attachWebSocketServer(server);
app.locals.broadcastMatchCreated = broadcastMatchCreated;

server.listen(PORT, HOST, () => {
  const baseURl =
    HOST === "0.0.0.0" ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
    console.log(`Server running on ${baseURl}`);
    console.log(
    `WebSocket server is running on ${baseURl.replace("http", "ws")}/ws`,
  );
});

// 00:50:10
// 01:39:04
// 02:04:39
