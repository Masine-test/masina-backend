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

  lastSeen[machineId] = now;
  offlineTriggered[machineId] = false;

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

    lastState[machineId] = state;
    lastChangeTime[machineId] = now;

    res.json({ status: "changed" });

  } catch (err) {
    console.error(err);
    res.status(500).send("error");
  }
});

// =======================
// 🏭 SVE MAŠINE
// =======================
app.get("/api/machines/all", (req, res) => {
  const now = new Date();

  const list = machines.map(id => {

    if (!lastSeen[id]) {
      return { machine_id: id, state: "OFFLINE", status: "NEVER" };
    }

    const diff = (now - lastSeen[id]) / 1000;

    if (diff > 30) {
      return { machine_id: id, state: "OFFLINE", status: "OFFLINE" };
    }

    return {
      machine_id: id,
      state: lastState[id],
      status: "ONLINE",
      created_at: lastChangeTime[id] // 🔥 BITNO ZA TIMER
    };
  });

  res.json(list);
});

// =======================
// ❤️ HEARTBEAT
// =======================
app.get("/api/heartbeat", (req, res) => {
  res.json({ server: "OK", time: new Date() });
});

// =======================
// 🆕 SHIFT STATS (FIX)
// =======================
app.get("/api/shift-stats", async (req, res) => {
  try {
    const now = new Date();
    const hour = now.getHours();

    let shiftStart = new Date(now);
    let shiftSeconds = 8 * 3600;

    if (hour >= 7 && hour < 16) {
      shiftStart.setHours(7,0,0,0);
      shiftSeconds = 9 * 3600;
    } else if (hour >= 16) {
      shiftStart.setHours(16,0,0,0);
      shiftSeconds = 8 * 3600;
    } else {
      shiftStart.setHours(0,0,0,0);
      shiftSeconds = 7 * 3600;
    }

    const result = await pool.query(`
      SELECT machine_id, state, SUM(duration) as total
      FROM events
      WHERE created_at >= $1
      GROUP BY machine_id, state
    `, [shiftStart]);

    const data = {};

    result.rows.forEach(r => {
      if (!data[r.machine_id]) {
        data[r.machine_id] = { RAD:0, PRIPREMA:0, ZASTOJ:0 };
      }

      data[r.machine_id][r.state] = Number(r.total);
    });

    // 🔥 REALTIME DODATAK + FIX
    machines.forEach(m => {

      if (!data[m]) data[m] = { RAD:0, PRIPREMA:0, ZASTOJ:0 };

      if (lastState[m] && lastChangeTime[m]) {

        const extra = Math.floor((now - lastChangeTime[m]) / 1000);

        if (lastState[m] === "RAD") {
          data[m].RAD += extra;
        }

        if (lastState[m] === "PRIPREMA") {
          data[m].PRIPREMA += extra;
        }

        if (lastState[m] === "ZASTOJ") {
          data[m].ZASTOJ += extra;
        }
      }

      let eff = Math.round((data[m].RAD / shiftSeconds) * 100);
      if (eff > 100) eff = 100;

      data[m].efficiency = eff;
    });

    res.json(data);

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
