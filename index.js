const machines = [
  "masina_01","masina_02","masina_03","masina_04","masina_05",
  "masina_06","masina_07","masina_08","masina_09","masina_10"
];

const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const cors = require("cors");

const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// =======================
// 📥 STATE MEMORY
// =======================
let lastState = {};
let lastChangeTime = {};
let lastSeen = {};
let offlineTriggered = {};

// =======================
// 📥 POST (ESP)
// =======================
app.post("/api/data", async (req, res) => {
  const { machineId, state } = req.body;

  if (!machineId || !state) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const now = new Date();

  // ONLINE povratak
  if (offlineTriggered[machineId]) {
    console.log(`✅ ${machineId} ONLINE opet`);
  }

  lastSeen[machineId] = now;
  offlineTriggered[machineId] = false;

  console.log("DATA:", req.body);

  try {
    if (!lastState[machineId]) {
      lastState[machineId] = state;
      lastChangeTime[machineId] = now;
      return res.json({ status: "init" });
    }

    if (state === lastState[machineId]) {
      return res.json({ status: "no change" });
    }

    const duration = Math.floor((now - lastChangeTime[machineId]) / 1000);

    await pool.query(
      "INSERT INTO events (machine_id, state, duration) VALUES ($1, $2, $3)",
      [machineId, lastState[machineId], duration]
    );

    // 🚨 ALARM
    if (lastState[machineId] === "ZASTOJ" && duration > 60) {
      console.log(`⚠️ ALARM: ${machineId} dug zastoj (${duration}s)`);
    }

    lastState[machineId] = state;
    lastChangeTime[machineId] = now;

    return res.json({ status: "changed" });

  } catch (err) {
    console.error(err);
    return res.status(500).send("error");
  }
});

// =======================
// 🏭 SVE MAŠINE (PRO STATUS)
// =======================
app.get("/api/machines/all", async (req, res) => {
  try {
    const now = new Date();

    const fullList = machines.map(id => {

      if (!lastSeen[id]) {
        return {
          machine_id: id,
          state: "OFFLINE",
          status: "NEVER",
          last_seen: null
        };
      }

      const diff = (now - lastSeen[id]) / 1000;

      if (diff > 30) {
        return {
          machine_id: id,
          state: "OFFLINE",
          status: "OFFLINE",
          last_seen: lastSeen[id]
        };
      }

      return {
        machine_id: id,
        state: lastState[id] || "UNKNOWN",
        status: "ONLINE",
        last_seen: lastSeen[id]
      };
    });

    res.json(fullList);

  } catch (err) {
    console.log(err);
    res.status(500).send("error");
  }
});

// =======================
// ❤️ HEARTBEAT (NEW)
// =======================
app.get("/api/heartbeat", (req, res) => {
  res.json({
    server: "OK",
    time: new Date()
  });
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
// 🚀 SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server radi na portu", PORT));

// =======================
// 🚨 OFFLINE DETEKCIJA
// =======================
setInterval(() => {
  const now = new Date();

  for (let machineId of machines) {

    if (!lastSeen[machineId]) {
      if (!offlineTriggered[machineId]) {
        offlineTriggered[machineId] = true;
        console.log(`🚨 ${machineId} OFFLINE (nikad nije online)`);
      }
      continue;
    }

    const diff = (now - lastSeen[machineId]) / 1000;

    if (diff > 30 && !offlineTriggered[machineId]) {
      offlineTriggered[machineId] = true;
      console.log(`🚨 ${machineId} OFFLINE (${Math.floor(diff)}s)`);
    }
  }
}, 10000);
