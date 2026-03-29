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
// ✅ SHIFT STATS (FIXED)
// =======================
app.get("/api/shift-stats", async (req, res) => {
  try {
    const now = new Date();
    const hour = now.getHours();

    let shiftStart = new Date(now);
    let shiftEnd = new Date(now);
    let shiftSeconds = 8 * 3600;

    if (hour >= 7 && hour < 16) {
      shiftStart.setHours(7,0,0,0);
      shiftEnd.setHours(16,0,0,0);
      shiftSeconds = 9 * 3600;
    } else if (hour >= 16) {
      shiftStart.setHours(16,0,0,0);
      shiftEnd.setDate(shiftEnd.getDate() + 1);
      shiftEnd.setHours(0,0,0,0);
      shiftSeconds = 8 * 3600;
    } else {
      shiftStart.setDate(now.getDate() - 1);
      shiftStart.setHours(0,0,0,0);
      shiftEnd.setHours(7,0,0,0);
      shiftSeconds = 7 * 3600;
    }

    const result = await pool.query(`
      SELECT machine_id, state, duration, created_at
      FROM events
      WHERE created_at < $2
      AND (created_at + (duration || ' seconds')::interval) > $1
    `, [shiftStart, shiftEnd]);

    const data = {};

    result.rows.forEach(ev => {
      let start = new Date(ev.created_at);
      let end = new Date(start.getTime() + ev.duration * 1000);

      if (start < shiftStart) start = shiftStart;
      if (end > shiftEnd) end = shiftEnd;

      const sec = Math.floor((end - start) / 1000);

      if (!data[ev.machine_id]) {
        data[ev.machine_id] = { RAD:0, PRIPREMA:0, ZASTOJ:0 };
      }

      if (!data[ev.machine_id][ev.state]) {
        data[ev.machine_id][ev.state] = 0;
      }

      data[ev.machine_id][ev.state] += sec;
    });

    // 🔥 REALTIME FIX (bez bugova)
    machines.forEach(m => {

      if (!data[m]) data[m] = { RAD:0, PRIPREMA:0, ZASTOJ:0 };

      if (lastState[m] && lastChangeTime[m]) {

        let start = new Date(lastChangeTime[m]);
        if (start < shiftStart) start = shiftStart;

        if (start < shiftEnd) {
          const extra = Math.floor((now - start) / 1000);

          if (!data[m][lastState[m]]) {
            data[m][lastState[m]] = 0;
          }

          data[m][lastState[m]] += extra;
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
// 📅 DAN + SMJENE (OSTAJE ISTO)
// =======================
app.get("/api/day-shift-stats", async (req, res) => {
  try {
    const { date, machine } = req.query;

    const dayStart = new Date(date);
    dayStart.setHours(0,0,0,0);

    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const result = await pool.query(`
      SELECT state, duration, created_at
      FROM events
      WHERE machine_id = $1
      AND created_at < $2
      AND (created_at + (duration || ' seconds')::interval) > $3
    `, [machine, dayEnd, dayStart]);

    const shifts = {
      I: { RAD:0, PRIPREMA:0, ZASTOJ:0 },
      II: { RAD:0, PRIPREMA:0, ZASTOJ:0 },
      III:{ RAD:0, PRIPREMA:0, ZASTOJ:0 }
    };

    function getShift(h){
      if (h>=7 && h<16) return "I";
      if (h>=16) return "II";
      return "III";
    }

    result.rows.forEach(ev=>{
      let start = new Date(ev.created_at);
      let end = new Date(start.getTime()+ev.duration*1000);

      if (start < dayStart) start = dayStart;
      if (end > dayEnd) end = dayEnd;

      while(start<end){
        const shift = getShift(start.getHours());
        const next = new Date(start);

        if (shift==="III") next.setHours(7,0,0,0);
        else if (shift==="I") next.setHours(16,0,0,0);
        else {
          next.setDate(next.getDate()+1);
          next.setHours(0,0,0,0);
        }

        if (next > end) next.setTime(end.getTime());

        const sec = Math.floor((next - start) / 1000);

        if (!shifts[shift][ev.state]) {
          shifts[shift][ev.state] = 0;
        }

        shifts[shift][ev.state] += sec;

        start = next;
      }
    });

    const durations = { I:9*3600, II:8*3600, III:7*3600 };

    for (let s in shifts) {
      const rad = shifts[s].RAD || 0;
      const used = rad + (shifts[s].PRIPREMA||0) + (shifts[s].ZASTOJ||0);

      shifts[s].NEAKTIVNA = durations[s] - used;
      if (shifts[s].NEAKTIVNA < 0) shifts[s].NEAKTIVNA = 0;

      let eff = Math.round((rad / durations[s]) * 100);
      if (eff > 100) eff = 100;

      shifts[s].efficiency = eff;
    }

    res.json(shifts);

  } catch(e){
    console.log(e);
    res.status(500).send("error");
  }
});

// =======================
// 📅 MJESEC (KALENDAR)
// =======================
app.get("/api/month-stats", async (req, res) => {
  try {
    const { machine, year, month } = req.query;

    if (!machine || !year || !month) {
      return res.status(400).send("Missing params");
    }

    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 1);

    const result = await pool.query(`
      SELECT created_at, state, duration
      FROM events
      WHERE machine_id = $1
      AND created_at < $3
      AND (created_at + (duration || ' seconds')::interval) > $2
    `, [machine, start, end]);

    const days = {};

    result.rows.forEach(ev => {
      const d = new Date(ev.created_at).getDate();

      if (!days[d]) days[d] = { RAD: 0 };

      if (ev.state === "RAD") {
        days[d].RAD += ev.duration;
      }
    });

    // efikasnost po danu
    for (let d in days) {
      days[d].eff = Math.round((days[d].RAD / (24 * 3600)) * 100);
    }

    res.json(days);

  } catch (e) {
    console.log(e);
    res.status(500).send("error");
  }
});

// =======================
// 🚀 SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server radi na portu", PORT));
