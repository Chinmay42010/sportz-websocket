import express from "express";

const app = express();

// JSON middleware
app.use(express.json());

// Root route
app.get("/", (req, res) => {
  res.json({ message: "Hello from Express server" });
});

const PORT = 8000;
const url = `http://localhost:${PORT}`;

app.listen(PORT, () => {
  console.log(`Server started. URL: ${url}`);
});
