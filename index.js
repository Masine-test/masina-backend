const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// POST (već imaš)
app.post("/api/data", async (req, res) => {
  const { machineId, state, duration } = req.body;

  try {
    await pool.query(
      "INSERT INTO events (machine_id, state, duration) VALUES ($1, $2, $3)",
      [machineId, state, duration]
    );

    res.json({ status: "ok" });
  } catch (err) {
    console.log(err);
    res.status(500).send("error");
  }
});


// 🔹 DODAJ OVO — HISTORIJA
app.get("/api/data", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM events ORDER BY created_at DESC LIMIT 50"
    );

    res.json(result.rows);
  } catch (err) {
    console.log(err);
    res.status(500).send("error");
  }
});


// 🔹 DODAJ OVO — STATISTIKA
app.get("/api/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT state, SUM(duration) as total_duration
      FROM events
      GROUP BY state
    `);

    res.json(result.rows);
  } catch (err) {
    console.log(err);
    res.status(500).send("error");
  }
});


// ⚠️ BONUS (preporučeno za Render)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server radi na portu", PORT));
