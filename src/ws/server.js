import { WebSocket, WebSocketServer } from "ws";
import { wsArcjet } from "../arcjet.js";

const matchSubscribers = new Map();

function subscribe(matchId, socket) {
    if (!matchSubscribers.has(matchId)) {
        matchSubscribers.set(matchId, new Set());
    }

    matchSubscribers.get(matchId).add(socket);
}

function unsubscribe(matchId, socket) {
    const subscribers = matchSubscribers.get(matchId);

    if (!subscribers) return;

    subscribers.delete(socket);

    if (subscribers.size === 0) {
        matchSubscribers.delete(matchId);
    }
}

function cleanupSubscriptions(socket) {
    for (const matchId of socket.subscriptions) {
        unsubscribe(matchId, socket);
    }
}

function sendJson(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify(payload));
}

function broadcastToAll(wss, payload) {
    for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;

        client.send(JSON.stringify(payload));
    }
}

function broadcastToMatch(matchId, payload) {
    {
        const subscribers = matchSubscribers.get(matchId);

        if (!subscribers || subscribers.size === 0) return;

        const message = JSON.stringify(payload);

        for (const client of subscribers) {
            if (client.readyState == WebSocket.OPEN) {
                client.send(message);
            }
        }
    }
}

function toMatchId(raw) {
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
}

function handleMessage(socket, data) {
    let message;

    try {
        message = JSON.parse(data.toString());
    } catch {
        sendJson(socket, { type: "error", code: "invalid_json", message: "Invalid Json" });
        return;
    }

    if (message?.type === "setSubscriptions" && Array.isArray(message.matchIds)) {
        // ponytail: naive resubscribe — clear then re-add, O(n) fine for few matches
        for (const id of socket.subscriptions) unsubscribe(id, socket);
        socket.subscriptions.clear();
        for (const raw of message.matchIds) {
            const id = toMatchId(raw);
            if (id === null) continue;
            subscribe(id, socket);
            socket.subscriptions.add(id);
        }
        sendJson(socket, { type: "subscriptions", matchIds: [...socket.subscriptions] });
        return;
    }

    if (message?.type === "subscribe") {
        const id = toMatchId(message.matchId);
        if (id === null) {
            sendJson(socket, { type: "error", code: "invalid_matchId", message: "matchId must be integer" });
            return;
        }
        subscribe(id, socket);
        socket.subscriptions.add(id);
        sendJson(socket, { type: "subscribed", matchId: id });
        return;
    }

    if (message?.type === "unsubscribe") {
        const id = toMatchId(message.matchId);
        if (id === null) {
            sendJson(socket, { type: "error", code: "invalid_matchId", message: "matchId must be integer" });
            return;
        }
        unsubscribe(id, socket);
        socket.subscriptions.delete(id);
        sendJson(socket, { type: "unsubscribed", matchId: id });
        return;
    }

    if (message?.type === "ping") {
        sendJson(socket, { type: "pong" });
        return;
    }
}

export function attachWebSocketServer(server) {
    const wss = new WebSocketServer({
        noServer: true,
        path: "/ws",
        maxPayload: 1024 * 1024,
    });

    server.on("upgrade", async (req, socket, head) => {
        if (!req.url || !req.url.startsWith("/ws")) {
            socket.destroy();
            return;
        }

        if (wsArcjet) {
            try {
                const decision = await wsArcjet.protect(req);

                if (decision.isDenied()) {
                    if (decision.reason.isRateLimit()) {
                        socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
                    } else {
                        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
                    }
                    socket.destroy();
                    return;
                }
            } catch (e) {
                console.error("WS upgrade error", e);
                socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
                socket.destroy();
                return;
            }
        }

        wss.handleUpgrade(req, socket, head, (ws) =>
            wss.emit("connection", ws, req),
        );
    });

    wss.on("connection", (socket, req) => {
        socket.isAlive = true;
        socket.on("pong", () => {
            socket.isAlive = true;
        });

        socket.subscriptions = new Set();

        sendJson(socket, { type: "welcome" });

        socket.on("message", (data) => {
            handleMessage(socket, data);
        });

        socket.on("error", console.error);

        socket.on("error", () => {
            socket.terminate();
        });

        socket.on("close", () => {
            cleanupSubscriptions(socket);
        });
    });

    const interval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    wss.on("close", () => clearInterval(interval));

    function broadcastMatchCreated(match) {
        broadcastToAll(wss, { type: "match_created", data: match });
    }

    function broadcastCommentary(matchId, comment) {
        broadcastToMatch(toMatchId(matchId) ?? matchId, { type: "commentary", data: comment });
    }

    function broadcastScoreUpdate(matchId, scores) {
        broadcastToMatch(toMatchId(matchId) ?? matchId, { type: "score_update", matchId: toMatchId(matchId) ?? matchId, data: scores });
    }

    function broadcastScorecard(matchId, scorecard) {
        broadcastToMatch(toMatchId(matchId) ?? matchId, { type: "scorecard", matchId: toMatchId(matchId) ?? matchId, data: scorecard });
    }

    return { broadcastMatchCreated, broadcastCommentary, broadcastScoreUpdate, broadcastScorecard };
}
