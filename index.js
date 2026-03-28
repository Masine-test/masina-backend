const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const cors = require("cors");

const app = express();

// 🔹 middleware
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// 🔹 baza
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});


// =======================
// 📥 POST PODATAKA (ESP)
// =======================
app.post("/api/data", async (req, res) => {
  const { machineId, state, duration } = req.body;

  // 🔍 log za debug
  console.log("DATA:", req.body);

  // ❗ validacija
  if (!machineId || !state || duration == null) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    await pool.query(
      "INSERT INTO events (machine_id, state, duration) VALUES ($1, $2, $3)",
      [machineId, state, duration]
    );

    // 🚨 ALARM LOGIKA
    if (state === "ZASTOJ" && duration > 60) {
      console.log("⚠️ ALARM: Dug zastoj!", {
        machineId,
        duration
      });
    }

    res.json({ status: "ok" });

  } catch (err) {
    console.log(err);
    res.status(500).send("error");
  }
});


// =======================
// 📊 HISTORIJA
// =======================
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


// =======================
// 📈 STATISTIKA
// =======================
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


// =======================
// 🟢 LIVE STATUS (najnoviji)
// =======================
app.get("/api/live", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM events
      ORDER BY created_at DESC
      LIMIT 1
    `);

    res.json(result.rows[0]);

  } catch (err) {
    console.log(err);
    res.status(500).send("error");
  }
});


// =======================
// 🥧 PROCENTI (za pie chart)
// =======================
app.get("/api/stats/percent", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        state,
        SUM(duration) as total,
        ROUND(100.0 * SUM(duration) / SUM(SUM(duration)) OVER (), 2) as percent
      FROM events
      GROUP BY state
    `);

    res.json(result.rows);

  } catch (err) {
    console.log(err);
    res.status(500).send("error");
  }
});


// =======================
// 🚀 SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server radi na portu", PORT));
