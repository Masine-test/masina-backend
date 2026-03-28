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
let lastState = {};
let lastChangeTime = {};
let lastSeen = {};
let offlineTriggered = {};

app.post("/api/data", async (req, res) => {
  const { machineId, state } = req.body;

  console.log("DATA:", req.body);

  if (!machineId || !state) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const now = new Date();
    lastSeen[machineId] = now;
    offlineTriggered[machineId] = false;

    // prvi put
    if (!lastState[machineId]) {
      lastState[machineId] = state;
      lastChangeTime[machineId] = now;

      console.log("INIT stanje:", state);
      return res.json({ status: "init" });
    }

    // nema promjene
    if (state === lastState[machineId]) {
      return res.json({ status: "no change" });
    }

    // promjena
    const duration = Math.floor((now - lastChangeTime[machineId]) / 1000);

    console.log("PROMJENA:", lastState[machineId], "→", state);
    console.log("Trajanje:", duration, "s");

    await pool.query(
      "INSERT INTO events (machine_id, state, duration) VALUES ($1, $2, $3)",
      [machineId, lastState[machineId], duration]
    );

    // 🚨 ALARM LOGIKA (ispravna verzija)
    if (lastState[machineId] === "ZASTOJ" && duration > 60) {
      console.log("⚠️ ALARM: Dug zastoj!", {
        machineId,
        duration
      });
    }

    // update
    lastState[machineId] = state;
    lastChangeTime[machineId] = now;

    return res.json({ status: "changed" });

  } catch (err) {
    console.error(err);
    return res.status(500).send("error");
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
// 🟢 LIVE STATUS
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
// 🥧 PROCENTI
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

setInterval(() => {
  const now = new Date();

  for (let machineId in lastSeen) {
    const diff = (now - lastSeen[machineId]) / 1000;

    if (diff > 30 && !offlineTriggered[machineId]) {
  offlineTriggered[machineId] = true;

  console.log(`🚨 ${machineId} OFFLINE!`);
}
  }
}, 10000);
