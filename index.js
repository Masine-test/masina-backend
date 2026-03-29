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

  if (offlineTriggered[machineId]) {
    console.log(`✅ ${machineId} ONLINE opet`);
  }

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
      return {
        machine_id: id,
        state: "OFFLINE",
        status: "NEVER",
        created_at: null
      };
    }

    const diff = (now - lastSeen[id]) / 1000;

    if (diff > 30) {
      return {
        machine_id: id,
        state: "OFFLINE",
        status: "OFFLINE",
        created_at: lastSeen[id]
      };
    }

    return {
      machine_id: id,
      state: lastState[id] || "UNKNOWN",
      status: "ONLINE",
      created_at: lastChangeTime[id]
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
// 📊 SHIFT STATS (FIXED SAMO OVO)
// =======================
app.get("/api/shift-stats", async (req, res) => {
  try {
    const now = new Date();
    const hour = now.getHours();

    let shiftStart = new Date(now);
    let shiftDurationHours = 8;

    if (hour >= 7 && hour < 16) {
      shiftStart.setHours(7, 0, 0, 0);
      shiftDurationHours = 9;
    } else if (hour >= 16) {
      shiftStart.setHours(16, 0, 0, 0);
      shiftDurationHours = 8;
    } else {
      shiftStart.setHours(0, 0, 0, 0);
      shiftDurationHours = 7;
    }

    // 🔥 FIXED QUERY (uzima samo dio koji ulazi u smjenu)
    const result = await pool.query(`
      SELECT machine_id, state, duration, created_at
      FROM events
      WHERE created_at < NOW()
      AND (created_at + (duration || ' seconds')::interval) > $1
    `, [shiftStart]);

    const data = {};

    result.rows.forEach(ev => {

      if (!data[ev.machine_id]) {
        data[ev.machine_id] = {
          RAD: 0,
          PRIPREMA: 0,
          ZASTOJ: 0
        };
      }

      let start = new Date(ev.created_at);
      let end = new Date(start.getTime() + ev.duration * 1000);

      if (start < shiftStart) start = shiftStart;

      const sec = Math.floor((end - start) / 1000);

      if (!data[ev.machine_id][ev.state]) {
        data[ev.machine_id][ev.state] = 0;
      }

      data[ev.machine_id][ev.state] += sec;
    });

    // 🔥 REALTIME + EFIKASNOST
    for (let m in data) {
      let rad = data[m].RAD || 0;

      if (lastState[m] === "RAD" && lastChangeTime[m]) {
        const extra = Math.floor((new Date() - lastChangeTime[m]) / 1000);
        rad += extra;
      }

      const max = shiftDurationHours * 3600;

      if (rad > max) rad = max;

      data[m].RAD = rad;

      let eff = Math.round((rad / max) * 100);
      if (eff > 100) eff = 100;

      data[m].efficiency = eff;
    }

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
