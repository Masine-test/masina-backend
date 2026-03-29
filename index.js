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

  try {
    // prvi put
    if (!lastState[machineId]) {
      lastState[machineId] = state;
      lastChangeTime[machineId] = now;
      return res.json({ status: "init" });
    }

    // nema promjene
    if (state === lastState[machineId]) {
      return res.json({ status: "no change" });
    }

    // promjena
    const duration = Math.floor((now - lastChangeTime[machineId]) / 1000);

    await pool.query(
      "INSERT INTO events (machine_id, state, duration) VALUES ($1, $2, $3)",
      [machineId, lastState[machineId], duration]
    );

    // ALARM
    if (lastState[machineId] === "ZASTOJ" && duration > 60) {
      console.log(`⚠️ ALARM: ${machineId} dug zastoj (${duration}s)`);
    }

    // update
    lastState[machineId] = state;
    lastChangeTime[machineId] = now;

    res.json({ status: "changed" });

  } catch (err) {
    console.error(err);
    res.status(500).send("error");
  }
});

// =======================
// 🏭 SVE MAŠINE (FIXED)
// =======================
app.get("/api/machines/all", (req, res) => {
  const now = new Date();

  const list = machines.map(id => {

    // nikad nije bila online
    if (!lastSeen[id]) {
      return {
        machine_id: id,
        state: "OFFLINE",
        status: "NEVER",
        created_at: null
      };
    }

    const diff = (now - lastSeen[id]) / 1000;

    // offline
    if (diff > 30) {
      return {
        machine_id: id,
        state: "OFFLINE",
        status: "OFFLINE",
        created_at: lastSeen[id]
      };
    }

    // online
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
// DODANO
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
      shiftStart.setDate(now.getDate() - 1);
      shiftStart.setHours(0, 0, 0, 0);
      shiftDurationHours = 7;
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
        data[r.machine_id] = {
          RAD: 0,
          PRIPREMA: 0,
          ZASTOJ: 0
        };
      }

      data[r.machine_id][r.state] = Number(r.total);
    });

   for (let m in data) {
  let rad = data[m].RAD || 0;

  // 🆕 REALTIME DODATAK
  if (lastState[m] === "RAD" && lastChangeTime[m]) {
    const extra = Math.floor((new Date() - lastChangeTime[m]) / 1000);
    rad += extra;
  }

  const max = shiftDurationHours * 3600;

  let efficiency = Math.round((rad / max) * 100);
  if (efficiency > 100) efficiency = 100;

  data[m].RAD = rad; // 🔥 update RAD da UI vidi pravi broj
  data[m].efficiency = efficiency;
}

    res.json(data);

  } catch (err) {
    console.log(err);
    res.status(500).send("error");
  }
});



// =======================
// 📅 DAN + SMJENE
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
  const priprema = shifts[s].PRIPREMA || 0;
  const zastoj = shifts[s].ZASTOJ || 0;

  const used = rad + priprema + zastoj;

  // 🆕 NEAKTIVNA
  shifts[s].NEAKTIVNA = durations[s] - used;
  if (shifts[s].NEAKTIVNA < 0) shifts[s].NEAKTIVNA = 0;

  // ⚙️ efikasnost (samo RAD)
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
// 📅 MJESEC (FIXED)
// =======================
app.get("/api/month-stats", async (req, res) => {
  try {
    const { machine, year, month } = req.query;

    if (!machine || !year || !month) {
      return res.status(400).send("Missing params");
    }

    const start = new Date(year, month-1, 1);
    const end = new Date(year, month, 1);

    const result = await pool.query(`
      SELECT created_at, state, duration
      FROM events
      WHERE machine_id = $1
      AND created_at < $3
      AND (created_at + (duration || ' seconds')::interval) > $2
    `,[machine,start,end]);

    const days = {};

    result.rows.forEach(ev=>{
      const d = new Date(ev.created_at).getDate();

      if(!days[d]) days[d]={ RAD:0 };

      if(ev.state==="RAD"){
        days[d].RAD += ev.duration;
      }
    });

    // efikasnost po danu (RAD / 24h)
    for(let d in days){
      days[d].eff = Math.round((days[d].RAD / (24*3600)) * 100);
    }

    res.json(days);

  } catch(e){
    console.log(e);
    res.status(500).send("error");
  }
});

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

// =======================
// 🚀 SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server radi na portu", PORT));
