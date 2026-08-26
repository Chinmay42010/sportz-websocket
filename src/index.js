import express from "express";
import { matchRouter } from "./routes/matches.js";

const app = express();
const PORT = 8000;
const url = `http://localhost:${PORT}`;

// JSON middleware
app.use(express.json());

// Root route
app.get("/", (req, res) => {
  res.json({ message: "Hello from Express server" });
});

app.use('/matches', matchRouter)
app.listen(PORT, () => {
  console.log(`Server started. URL: ${url}`);
});

// 50:10
// 1:39:04
