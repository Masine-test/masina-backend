const machines = [
  "masina_01",
  "masina_02",
  "masina_03",
  "masina_04",
  "masina_05",
  "masina_06",
  "masina_07",
  "masina_08",
  "masina_09",
  "masina_10"
];

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

  const now = new Date();

  // ✅ ako je bila offline → sad je online
  if (offlineTriggered[machineId]) {
    console.log(`✅ ${machineId} ONLINE opet`);
  }

  // 🔥 uvijek update
  lastSeen[machineId] = now;
  offlineTriggered[machineId] = false;

  console.log("DATA:", req.body);

  if (!machineId || !state) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
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

    // 🚨 ALARM LOGIKA
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
// 🏭 SVE MAŠINE (zadnje stanje)
// =======================
app.get("/api/machines/all", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (machine_id) *
      FROM events
      ORDER BY machine_id, created_at DESC
    `);

    const dbMachines = result.rows;

    const map = {};
    dbMachines.forEach(m => {
      map[m.machine_id] = m;
    });

    const now = new Date();

    const fullList = machines.map(id => {

      // nikad nije online bila
      if (!lastSeen[id]) {
        return {
          machine_id: id,
          state: "OFFLINE",
          status: "NEVER",
          created_at: null
        };
      }

      const diff = (now - lastSeen[id]) / 1000;

      // bila online ali pala
      if (diff > 30) {
        return {
          machine_id: id,
          state: "OFFLINE",
          status: "OFFLINE",
          created_at: lastSeen[id]
        };
      }

      // online je
      return {
        machine_id: id,
        state: lastState[id] || "UNKNOWN",
        status: "ONLINE",
        created_at: lastChangeTime[id] || now
      };
    });

    res.json(fullList);

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

// =======================
// 🚨 OFFLINE DETEKCIJA
// =======================
setInterval(() => {
  const now = new Date();

  for (let machineId of machines) {

    // nikad viđena mašina
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
