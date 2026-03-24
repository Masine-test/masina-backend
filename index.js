const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

app.listen(3000, () => console.log("Server radi"));