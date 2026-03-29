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
// Za kalendar

app.get("/api/day-shift-stats", async (req, res) => {
  try {
    const { date, machine } = req.query;

    if (!date || !machine) {
      return res.status(400).send("Missing params");
    }

    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);

    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    // uzmi sve evente za tu mašinu i dan
    const result = await pool.query(`
      SELECT state, duration, created_at
      FROM events
      WHERE machine_id = $1
      AND created_at < $2
      AND (created_at + (duration || ' seconds')::interval) > $3
    `, [machine, dayEnd, dayStart]);

    // priprema rezultata
    const shifts = {
      I: { RAD: 0, PRIPREMA: 0, ZASTOJ: 0 },
      II: { RAD: 0, PRIPREMA: 0, ZASTOJ: 0 },
      III: { RAD: 0, PRIPREMA: 0, ZASTOJ: 0 }
    };

    function getShift(date) {
      const h = date.getHours();
      if (h >= 7 && h < 16) return "I";
      if (h >= 16) return "II";
      return "III";
    }

    result.rows.forEach(ev => {
      let start = new Date(ev.created_at);
      let end = new Date(start.getTime() + ev.duration * 1000);

      // ograniči na taj dan
      if (start < dayStart) start = dayStart;
      if (end > dayEnd) end = dayEnd;

      while (start < end) {
        const currentShift = getShift(start);

        let nextBoundary = new Date(start);

        if (currentShift === "III") {
          nextBoundary.setHours(7, 0, 0, 0);
        } else if (currentShift === "I") {
          nextBoundary.setHours(16, 0, 0, 0);
        } else {
          nextBoundary.setDate(nextBoundary.getDate() + 1);
          nextBoundary.setHours(0, 0, 0, 0);
        }

        if (nextBoundary > end) nextBoundary = end;

        const seconds = Math.floor((nextBoundary - start) / 1000);

        if (shifts[currentShift][ev.state] !== undefined) {
          shifts[currentShift][ev.state] += seconds;
        }

        start = nextBoundary;
      }
    });

    // ⚙️ efikasnost
    const shiftDurations = {
      I: 9 * 3600,
      II: 8 * 3600,
      III: 7 * 3600
    };

    for (let s in shifts) {
      const rad = shifts[s].RAD || 0;
      let eff = Math.round((rad / shiftDurations[s]) * 100);
      if (eff > 100) eff = 100;

      shifts[s].efficiency = eff;

      // opcionalno NEAKTIVNA
      const used = shifts[s].RAD + shifts[s].PRIPREMA + shifts[s].ZASTOJ;
      shifts[s].NEAKTIVNA = shiftDurations[s] - used;
      if (shifts[s].NEAKTIVNA < 0) shifts[s].NEAKTIVNA = 0;
    }

    res.json(shifts);

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
//SMJENE RAZLICITO TRAJANJE
app.get("/api/shift-stats", async (req, res) => {
  try {
    const now = new Date();
    const hour = now.getHours();

    let shiftStart = new Date(now);
    let shiftDurationHours = 8;

    // 🧠 definicija smjena
    if (hour >= 7 && hour < 16) {
      shiftStart.setHours(7, 0, 0, 0);
      shiftDurationHours = 9;
    } else if (hour >= 16) {
      shiftStart.setHours(16, 0, 0, 0);
      shiftDurationHours = 8;
    } else {
      shiftStart.setDate(now.getDate() - 1);
      shiftStart.setHours(0, 0, 0, 0);
      shiftDurationHours = 7;
    }

    // 📊 uzmi podatke iz baze
    const result = await pool.query(`
      SELECT machine_id, state, SUM(duration) as total
      FROM events
      WHERE created_at >= $1
      GROUP BY machine_id, state
    `, [shiftStart]);

    const data = {};

    result.rows.forEach(r => {
      if (!data[r.machine_id]) {
        data[r.machine_id] = {
          RAD: 0,
          PRIPREMA: 0,
          ZASTOJ: 0
        };
      }

      data[r.machine_id][r.state] = Number(r.total);
    });

    // ⚙️ efikasnost (SAMO RAD!)
    for (let m in data) {
      const rad = data[m].RAD || 0;
      const max = shiftDurationHours * 3600;

      let efficiency = 0;
      if (max > 0) {
        efficiency = Math.round((rad / max) * 100);
      }

      if (efficiency > 100) efficiency = 100;

      data[m].efficiency = efficiency;
    }

    res.json(data);

  } catch (err) {
    console.log(err);
    res.status(500).send("error");
  }
});

