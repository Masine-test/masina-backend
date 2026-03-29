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

    // 🔥 REALTIME samo ako je unutar smjene
    for (let m of machines) {

      if (!data[m]) {
        data[m] = { RAD: 0, PRIPREMA: 0, ZASTOJ: 0 };
      }

      if (
        lastState[m] &&
        lastChangeTime[m] &&
        lastChangeTime[m] >= shiftStart
      ) {
        const extra = Math.floor((new Date() - lastChangeTime[m]) / 1000);

        data[m][lastState[m]] += extra;
      }

      const max = shiftDurationHours * 3600;
      const rad = data[m].RAD || 0;

      let efficiency = Math.round((rad / max) * 100);
      if (efficiency > 100) efficiency = 100;

      data[m].efficiency = efficiency;
    }

    res.json({
      data,
      shiftStart
    });

  } catch (err) {
    console.log(err);
    res.status(500).send("error");
  }
});
