require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// ── DATABASE ──────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));

// ── INIT DATABASE ─────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shifts (
      id            SERIAL PRIMARY KEY,
      clerk_name    TEXT NOT NULL,
      store         TEXT NOT NULL DEFAULT 'razco',
      shift_date    DATE NOT NULL DEFAULT CURRENT_DATE,
      shift_step    INTEGER DEFAULT 0,
      completed     JSONB DEFAULT '[]',
      batches       JSONB DEFAULT '[]',
      flags         JSONB DEFAULT '[]',
      expiry        JSONB DEFAULT '[]',
      mismatches    JSONB DEFAULT '[]',
      tasks         JSONB DEFAULT '[]',
      dept_walk     JSONB DEFAULT '[]',
      missing_note  TEXT DEFAULT '',
      sop_done      JSONB DEFAULT '{}',
      updated_at    TIMESTAMP DEFAULT NOW(),
      UNIQUE(clerk_name, shift_date, store)
    );

    CREATE TABLE IF NOT EXISTS shift_events (
      id          SERIAL PRIMARY KEY,
      clerk_name  TEXT NOT NULL,
      store       TEXT NOT NULL,
      shift_date  DATE NOT NULL DEFAULT CURRENT_DATE,
      event_type  TEXT NOT NULL,
      event_data  JSONB DEFAULT '{}',
      created_at  TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("Database ready");
}

// ── ROUTES ────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Razi-Nova API running", time: new Date().toISOString() });
});

// ── SAVE shift progress (called every state change + every 30s)
app.post("/api/shift/save", async (req, res) => {
  try {
    const {
      clerkName, store = "razco", shiftStep, completed,
      batches, flags, expiry, mismatches, tasks,
      deptWalk, missingNote, sopDone
    } = req.body;

    if (!clerkName) return res.status(400).json({ error: "clerkName required" });

    await pool.query(`
      INSERT INTO shifts (clerk_name, store, shift_date, shift_step, completed, batches, flags, expiry, mismatches, tasks, dept_walk, missing_note, sop_done, updated_at)
      VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      ON CONFLICT (clerk_name, shift_date, store)
      DO UPDATE SET
        shift_step   = EXCLUDED.shift_step,
        completed    = EXCLUDED.completed,
        batches      = EXCLUDED.batches,
        flags        = EXCLUDED.flags,
        expiry       = EXCLUDED.expiry,
        mismatches   = EXCLUDED.mismatches,
        tasks        = EXCLUDED.tasks,
        dept_walk    = EXCLUDED.dept_walk,
        missing_note = EXCLUDED.missing_note,
        sop_done     = EXCLUDED.sop_done,
        updated_at   = NOW()
    `, [
      clerkName, store, shiftStep,
      JSON.stringify(completed || []),
      JSON.stringify(batches || []),
      JSON.stringify(flags || []),
      JSON.stringify(expiry || []),
      JSON.stringify(mismatches || []),
      JSON.stringify(tasks || []),
      JSON.stringify(deptWalk || []),
      missingNote || "",
      JSON.stringify(sopDone || {})
    ]);

    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (e) {
    console.error("Save error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── LOAD shift (clerk resumes after crash)
app.get("/api/shift/load", async (req, res) => {
  try {
    const { clerkName, store = "razco" } = req.query;
    if (!clerkName) return res.status(400).json({ error: "clerkName required" });

    const result = await pool.query(`
      SELECT * FROM shifts
      WHERE clerk_name = $1 AND store = $2 AND shift_date = CURRENT_DATE
      LIMIT 1
    `, [clerkName, store]);

    if (result.rows.length === 0) return res.json({ found: false });

    const row = result.rows[0];
    res.json({
      found: true,
      clerkName:   row.clerk_name,
      shiftStep:   row.shift_step,
      completed:   row.completed,
      batches:     row.batches,
      flags:       row.flags,
      expiry:      row.expiry,
      mismatches:  row.mismatches,
      tasks:       row.tasks,
      deptWalk:    row.dept_walk,
      missingNote: row.missing_note,
      sopDone:     row.sop_done,
      updatedAt:   row.updated_at,
    });
  } catch (e) {
    console.error("Load error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET all today's shifts (manager dashboard)
app.get("/api/shifts/today", async (req, res) => {
  try {
    const { store = "razco" } = req.query;
    const result = await pool.query(`
      SELECT
        clerk_name, shift_step, completed, batches,
        flags, expiry, mismatches, tasks,
        dept_walk, missing_note, sop_done, updated_at
      FROM shifts
      WHERE store = $1 AND shift_date = CURRENT_DATE
      ORDER BY updated_at DESC
    `, [store]);

    res.json({ shifts: result.rows.map(row => ({
      clerkName:   row.clerk_name,
      shiftStep:   row.shift_step,
      completed:   row.completed,
      batches:     row.batches,
      flags:       row.flags,
      expiry:      row.expiry,
      mismatches:  row.mismatches,
      tasks:       row.tasks,
      deptWalk:    row.dept_walk,
      missingNote: row.missing_note,
      sopDone:     row.sop_done,
      updatedAt:   row.updated_at,
    }))});
  } catch (e) {
    console.error("Today shifts error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── LOG event (mismatch found, item pulled, step completed, etc.)
app.post("/api/shift/event", async (req, res) => {
  try {
    const { clerkName, store = "razco", eventType, eventData } = req.body;
    if (!clerkName || !eventType) return res.status(400).json({ error: "clerkName and eventType required" });

    await pool.query(`
      INSERT INTO shift_events (clerk_name, store, shift_date, event_type, event_data)
      VALUES ($1, $2, CURRENT_DATE, $3, $4)
    `, [clerkName, store, eventType, JSON.stringify(eventData || {})]);

    res.json({ ok: true });
  } catch (e) {
    console.error("Event log error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CLEAR shift (end of shift)
app.delete("/api/shift/clear", async (req, res) => {
  try {
    const { clerkName, store = "razco" } = req.body;
    if (!clerkName) return res.status(400).json({ error: "clerkName required" });

    await pool.query(`
      UPDATE shifts SET shift_step = -1, updated_at = NOW()
      WHERE clerk_name = $1 AND store = $2 AND shift_date = CURRENT_DATE
    `, [clerkName, store]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HISTORICAL shifts (last 30 days)
app.get("/api/shifts/history", async (req, res) => {
  try {
    const { store = "razco", days = 30 } = req.query;
    const result = await pool.query(`
      SELECT clerk_name, shift_date, shift_step, completed, updated_at
      FROM shifts
      WHERE store = $1 AND shift_date >= CURRENT_DATE - INTERVAL '${parseInt(days)} days'
      ORDER BY shift_date DESC, updated_at DESC
    `, [store]);
    res.json({ history: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── START ─────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Razi-Nova API running on port ${PORT}`));
  })
  .catch(err => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
