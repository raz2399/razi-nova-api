require("dotenv").config();
const express = require("express");
const { Pool }  = require("pg");
const cors      = require("cors");

const {
  calcSuggestedPrice, createAction, buildBRdataBatchEntry,
  ACTION_TYPES, TOKEN_STATES, suggestTPREndDate,
} = require("./action-engine");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shifts (
      id            SERIAL PRIMARY KEY,
      clerk_name    TEXT NOT NULL,
      store         TEXT NOT NULL DEFAULT 'razco-lindsay',
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

    CREATE TABLE IF NOT EXISTS brdata_batches (
      id          SERIAL PRIMARY KEY,
      batch_id    TEXT NOT NULL,
      batch_name  TEXT NOT NULL,
      description TEXT,
      item_count  INTEGER DEFAULT 0,
      exported    BOOLEAN DEFAULT FALSE,
      export_date DATE,
      store       TEXT NOT NULL DEFAULT 'razco-lindsay',
      synced_at   TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS actions (
      id                  TEXT PRIMARY KEY,
      item_id             TEXT,
      upc                 TEXT NOT NULL,
      description         TEXT NOT NULL,
      dept                TEXT,
      aisle               TEXT,
      qty                 INTEGER DEFAULT 1,
      days_left           INTEGER,
      expiry_date         DATE,
      current_retail      NUMERIC(10,2),
      cost                NUMERIC(10,2),
      action_type         TEXT NOT NULL,
      batch_id            TEXT,
      batch_name          TEXT,
      suggested_price     NUMERIC(10,2),
      final_price         NUMERIC(10,2),
      discount_pct        INTEGER,
      margin_pct          NUMERIC(5,1),
      floor_price         NUMERIC(10,2),
      customer_saves      NUMERIC(10,2),
      tpr_start           DATE,
      tpr_end             DATE,
      state               TEXT NOT NULL DEFAULT 'approved',
      state_history       JSONB DEFAULT '[]',
      approved_by         TEXT DEFAULT 'Raz',
      approved_at         TIMESTAMP DEFAULT NOW(),
      clerk_name          TEXT,
      label_printed_at    TIMESTAMP,
      shelf_confirmed_at  TIMESTAMP,
      resolved_at         TIMESTAMP,
      sent_to_brdata      BOOLEAN DEFAULT FALSE,
      sent_at             TIMESTAMP,
      brdata_confirmed    BOOLEAN DEFAULT FALSE,
      store               TEXT DEFAULT 'razco-lindsay',
      created_at          TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_actions_state ON actions(state);
    CREATE INDEX IF NOT EXISTS idx_actions_store ON actions(store);
    CREATE INDEX IF NOT EXISTS idx_actions_date  ON actions(created_at);
    CREATE INDEX IF NOT EXISTS idx_actions_upc   ON actions(upc);
  `);
  console.log("All tables ready");
}

// ── HEALTH ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Razi-Nova API v2", time: new Date().toISOString() });
});

// ── SHIFT ROUTES ──────────────────────────────────────────────
app.post("/api/shift/save", async (req, res) => {
  try {
    const { clerkName, store="razco-lindsay", shiftStep, completed, batches, flags, expiry, mismatches, tasks, deptWalk, missingNote, sopDone } = req.body;
    if (!clerkName) return res.status(400).json({ error:"clerkName required" });
    await pool.query(`
      INSERT INTO shifts (clerk_name,store,shift_date,shift_step,completed,batches,flags,expiry,mismatches,tasks,dept_walk,missing_note,sop_done,updated_at)
      VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (clerk_name,shift_date,store) DO UPDATE SET
        shift_step=EXCLUDED.shift_step, completed=EXCLUDED.completed, batches=EXCLUDED.batches,
        flags=EXCLUDED.flags, expiry=EXCLUDED.expiry, mismatches=EXCLUDED.mismatches,
        tasks=EXCLUDED.tasks, dept_walk=EXCLUDED.dept_walk, missing_note=EXCLUDED.missing_note,
        sop_done=EXCLUDED.sop_done, updated_at=NOW()
    `, [clerkName,store,shiftStep,JSON.stringify(completed||[]),JSON.stringify(batches||[]),JSON.stringify(flags||[]),JSON.stringify(expiry||[]),JSON.stringify(mismatches||[]),JSON.stringify(tasks||[]),JSON.stringify(deptWalk||[]),missingNote||"",JSON.stringify(sopDone||{})]);
    res.json({ ok:true, savedAt:new Date().toISOString() });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get("/api/shift/load", async (req, res) => {
  try {
    const { clerkName, store="razco-lindsay" } = req.query;
    if (!clerkName) return res.status(400).json({ error:"clerkName required" });
    const r = await pool.query(`SELECT * FROM shifts WHERE clerk_name=$1 AND store=$2 AND shift_date=CURRENT_DATE LIMIT 1`,[clerkName,store]);
    if (!r.rows.length) return res.json({ found:false });
    const row = r.rows[0];
    res.json({ found:true, clerkName:row.clerk_name, shiftStep:row.shift_step, completed:row.completed, batches:row.batches, flags:row.flags, expiry:row.expiry, mismatches:row.mismatches, tasks:row.tasks, deptWalk:row.dept_walk, missingNote:row.missing_note, sopDone:row.sop_done, updatedAt:row.updated_at });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get("/api/shifts/today", async (req, res) => {
  try {
    const { store="razco-lindsay" } = req.query;
    const r = await pool.query(`SELECT * FROM shifts WHERE store=$1 AND shift_date=CURRENT_DATE ORDER BY updated_at DESC`,[store]);
    res.json({ shifts:r.rows.map(row=>({ clerkName:row.clerk_name, shiftStep:row.shift_step, completed:row.completed, batches:row.batches, flags:row.flags, expiry:row.expiry, mismatches:row.mismatches, tasks:row.tasks, deptWalk:row.dept_walk, missingNote:row.missing_note, sopDone:row.sop_done, updatedAt:row.updated_at })) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post("/api/shift/event", async (req, res) => {
  try {
    const { clerkName, store="razco-lindsay", eventType, eventData } = req.body;
    if (!clerkName||!eventType) return res.status(400).json({ error:"clerkName and eventType required" });
    await pool.query(`INSERT INTO shift_events (clerk_name,store,shift_date,event_type,event_data) VALUES ($1,$2,CURRENT_DATE,$3,$4)`,[clerkName,store,eventType,JSON.stringify(eventData||{})]);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.delete("/api/shift/clear", async (req, res) => {
  try {
    const { clerkName, store="razco-lindsay" } = req.body;
    if (!clerkName) return res.status(400).json({ error:"clerkName required" });
    await pool.query(`UPDATE shifts SET shift_step=-1, updated_at=NOW() WHERE clerk_name=$1 AND store=$2 AND shift_date=CURRENT_DATE`,[clerkName,store]);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get("/api/shifts/history", async (req, res) => {
  try {
    const { store="razco-lindsay", days=30 } = req.query;
    const r = await pool.query(`SELECT clerk_name,shift_date,shift_step,completed,updated_at FROM shifts WHERE store=$1 AND shift_date>=CURRENT_DATE-INTERVAL '${parseInt(days)} days' ORDER BY shift_date DESC,updated_at DESC`,[store]);
    res.json({ history:r.rows });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── BRDATA BRIDGE ROUTES ──────────────────────────────────────
// Bridge posts available batches at 6AM and on demand
app.post("/api/brdata/batches/sync", async (req, res) => {
  try {
    const { store="razco-lindsay", batches } = req.body;
    if (!Array.isArray(batches)) return res.status(400).json({ error:"batches array required" });
    for (const b of batches) {
      await pool.query(`
        INSERT INTO brdata_batches (batch_id,batch_name,description,item_count,exported,export_date,store,synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT DO NOTHING
      `,[b.id,b.name,b.description||"",b.itemCount||0,b.exported||false,b.exportDate||null,store]);
    }
    res.json({ ok:true, synced:batches.length });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// App reads today's available batches to show Raz
app.get("/api/brdata/batches/today", async (req, res) => {
  try {
    const { store="razco-lindsay" } = req.query;
    const r = await pool.query(`SELECT batch_id,batch_name,description,item_count,exported,synced_at FROM brdata_batches WHERE store=$1 AND synced_at >= CURRENT_DATE::timestamp ORDER BY batch_id ASC`,[store]);
    res.json({ batches:r.rows, count:r.rows.length });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Bridge heartbeat — confirms Windows computer is alive
app.post("/api/brdata/heartbeat", async (req, res) => {
  const { store, computer, brdata } = req.body;
  console.log(`Bridge: ${store} | ${computer} | brdata=${brdata}`);
  res.json({ ok:true, serverTime:new Date().toISOString() });
});

// Bridge polls for approved actions waiting to be executed in BRdata
app.get("/api/brdata/pending", async (req, res) => {
  try {
    const { store="razco-lindsay" } = req.query;
    const r = await pool.query(`SELECT * FROM actions WHERE store=$1 AND state='approved' AND sent_to_brdata=FALSE ORDER BY days_left ASC, created_at ASC`,[store]);
    const entries = r.rows.map(row => buildBRdataBatchEntry({
      id:row.id, itemId:row.item_id, upc:row.upc, description:row.description,
      dept:row.dept, aisle:row.aisle, qty:row.qty,
      currentRetail:parseFloat(row.current_retail), finalPrice:parseFloat(row.final_price),
      discountPct:row.discount_pct, customerSaves:parseFloat(row.customer_saves),
      expiryDate:row.expiry_date, actionType:row.action_type,
      batchId:row.batch_id, batchName:row.batch_name,
      tprStartDate:row.tpr_start, tprEndDate:row.tpr_end,
    })).filter(Boolean);
    res.json({ pending:entries, count:entries.length });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Bridge confirms it executed an action — moves token to label_ready
app.post("/api/brdata/confirm", async (req, res) => {
  try {
    const { actionId, store="razco-lindsay" } = req.body;
    if (!actionId) return res.status(400).json({ error:"actionId required" });
    const now = new Date().toISOString();
    await pool.query(`
      UPDATE actions SET state='label_ready', sent_to_brdata=TRUE, sent_at=NOW(), brdata_confirmed=TRUE,
        state_history=state_history||$1::jsonb WHERE id=$2 AND store=$3
    `,[JSON.stringify([{state:"label_ready",at:now,by:"brdata_bridge"}]),actionId,store]);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── ACTION PIPELINE ROUTES ────────────────────────────────────
// Price suggestion — no side effects, just calculates
app.post("/api/actions/price-suggest", async (req, res) => {
  try {
    const { item } = req.body;
    if (!item) return res.status(400).json({ error:"item required" });
    res.json({ pricing:calcSuggestedPrice(item), tprEndDate:suggestTPREndDate(item.expiryDate) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Raz approves — batchId is required (Raz picks from today's list)
app.post("/api/actions/approve", async (req, res) => {
  try {
    const { item, actionType, finalPrice, tprEndDate, batchId, batchName, store="razco-lindsay" } = req.body;
    if (!item||!actionType) return res.status(400).json({ error:"item and actionType required" });
    if (!batchId)           return res.status(400).json({ error:"batchId required" });

    const aType   = ACTION_TYPES[actionType.toUpperCase()] || ACTION_TYPES.MARKDOWN;
    const pricing = calcSuggestedPrice(item);
    const endDate = tprEndDate || (aType.id==="tpr" ? suggestTPREndDate(item.expiryDate) : null);
    const action  = createAction(item, aType, pricing, endDate);

    action.batchId   = batchId;
    action.batchName = batchName || `Batch ${batchId}`;
    if (finalPrice) action.finalPrice = finalPrice;

    await pool.query(`
      INSERT INTO actions (id,item_id,upc,description,dept,aisle,qty,days_left,expiry_date,current_retail,cost,action_type,batch_id,batch_name,suggested_price,final_price,discount_pct,margin_pct,floor_price,customer_saves,tpr_start,tpr_end,state,state_history,store)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
      ON CONFLICT (id) DO NOTHING
    `,[action.id,action.itemId,action.upc,action.description,action.dept,action.aisle,action.qty,action.daysLeft,action.expiryDate,action.currentRetail,action.cost,action.actionType,action.batchId,action.batchName,action.suggestedPrice,action.finalPrice,action.discountPct,action.marginPct,action.floorPrice,action.customerSaves,action.tprStartDate,action.tprEndDate,action.state,JSON.stringify(action.stateHistory),store]);

    res.json({ ok:true, actionId:action.id, batch:buildBRdataBatchEntry(action) });
  } catch(e) {
    console.error("approve:", e.message);
    res.status(500).json({ error:e.message });
  }
});

// Advance token state — used by bridge, clerk, and Raz
app.patch("/api/actions/:id/state", async (req, res) => {
  try {
    const { id } = req.params;
    const { state, clerkName, finalPrice, by } = req.body;
    if (!state) return res.status(400).json({ error:"state required" });

    const valid = Object.values(TOKEN_STATES).map(s=>s.id);
    if (!valid.includes(state)) return res.status(400).json({ error:`invalid state: ${state}` });

    const now  = new Date().toISOString();
    const hist = JSON.stringify([{ state, at:now, by:by||clerkName||"system" }]);
    const sets = ["state=$3","state_history=state_history||$1::jsonb"];
    const vals = [hist, id, state];
    let   pidx = 4;

    if (clerkName)  { sets.push(`clerk_name=$${pidx++}`);   vals.push(clerkName); }
    if (finalPrice) { sets.push(`final_price=$${pidx++}`);  vals.push(finalPrice); }
    if (state==="label_ready")              { sets.push("sent_to_brdata=TRUE","sent_at=NOW()"); }
    if (state==="on_shelf")                 { sets.push("shelf_confirmed_at=NOW()"); }
    if (state==="resolved"||state==="pulled") { sets.push("resolved_at=NOW()"); }

    await pool.query(`UPDATE actions SET ${sets.join(",")} WHERE id=$2`, vals);
    res.json({ ok:true, id, state });
  } catch(e) {
    res.status(500).json({ error:e.message });
  }
});

// Manager board — full view sorted by urgency
app.get("/api/actions/board", async (req, res) => {
  try {
    const { store="razco-lindsay", date } = req.query;
    const since = date || new Date().toISOString().slice(0,10);
    const r = await pool.query(`SELECT * FROM actions WHERE store=$1 AND created_at>=$2::date ORDER BY days_left ASC, created_at DESC`,[store,since]);
    const rows = r.rows;
    res.json({
      summary:{ approved:rows.filter(r=>r.state==="approved").length, label_ready:rows.filter(r=>r.state==="label_ready").length, on_shelf:rows.filter(r=>r.state==="on_shelf").length, pulled:rows.filter(r=>r.state==="pulled").length, resolved:rows.filter(r=>r.state==="resolved").length, total:rows.length },
      items:rows,
    });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Clerk task list — sorted by urgency (lowest days_left first)
app.get("/api/actions/clerk-tasks", async (req, res) => {
  try {
    const { store="razco-lindsay" } = req.query;
    const today = new Date().toISOString().slice(0,10);
    const r = await pool.query(`SELECT * FROM actions WHERE store=$1 AND created_at>=$2::date AND state IN ('label_ready','approved') ORDER BY days_left ASC`,[store,today]);
    res.json({
      print_labels: r.rows.filter(row=>row.state==="label_ready").map(row=>({
        actionId:row.id, upc:row.upc, description:row.description, aisle:row.aisle,
        qty:row.qty, daysLeft:row.days_left, wasPrice:parseFloat(row.current_retail),
        nowPrice:parseFloat(row.final_price), savings:parseFloat(row.customer_saves),
        discountPct:row.discount_pct, batchId:row.batch_id, batchName:row.batch_name, expiryDate:row.expiry_date,
      })),
      pending_brdata: r.rows.filter(row=>row.state==="approved").map(row=>({
        actionId:row.id, description:row.description, aisle:row.aisle, daysLeft:row.days_left, batchId:row.batch_id,
      })),
    });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── START ─────────────────────────────────────────────────────
initDB()
  .then(() => app.listen(PORT, () => console.log(`Razi-Nova API v2 on port ${PORT}`)))
  .catch(err => { console.error("DB init failed:", err.message); process.exit(1); });
