// ═══════════════════════════════════════════════════════════════
// RAZI-NOVA MODULES v8  (add-on to server.js — no new npm packages)
//
//  • Day Run     — one shared shift per store per day (survives refresh,
//                  works across Zebra / phones), end-of-shift confirmation
//  • Aisle Walk  — QR proof-of-walk per aisle, 3 yes/no checks,
//                  missed-aisle alert + end-of-day report
//  • TPR Check   — clerk decisions (continue / let end) with reasons
//  • Verify      — weekly-ad / sale items held from markdown, clerk
//                  verifies them on the shelf
//  • Manager Tasks — tasks Raz assigns, visible on every device
//  • Telegram    — alerts + /report /status commands
//
//  All dates use Pacific time (Railway runs on UTC).
// ═══════════════════════════════════════════════════════════════
"use strict";
const https = require("https");

const TZ            = "America/Los_Angeles";
const DEFAULT_STORE = "razco-lindsay";
const MANAGER_PIN   = process.env.MANAGER_PIN || "1234";
const CUTOFF_HOUR   = parseInt(process.env.WALK_CUTOFF_HOUR || "19", 10); // missed-aisle alert (PT)
const REPORT_HOUR   = parseInt(process.env.REPORT_HOUR || "20", 10);      // end-of-day report (PT)
const MIN_AISLE_SEC = parseInt(process.env.MIN_AISLE_SECONDS || "30", 10);
const STEP_LABELS   = ["Today's Focus","TPR Check","Pull Tags","Process Batches","Expiry","Aisle Walk","Assigned Tasks","End of Shift"];
const DAY_NAMES     = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

// Lindsay QR zones — same QR codes already printed for the Shelf system
const LINDSAY_ZONES = [
  { code:"1A", aisle:"1", name:"Dairy & deli wall", contents:"Mexican cheese & crema, chorizo & longaniza, yogurt & yogurt drinks, sour cream, cream cheese, butter & margarine, refrigerated dough, cakes & pies case, chilled juice, lunch meat, franks, bacon, Lunchables, deli salads, shredded cheese", order:10, kind:"aisle", qr:"RZN-LINDSAY-1A" },
  { code:"1B", aisle:"1", name:"Condiments & Mexican foods", contents:"Salad dressing, mayo, croutons, vinegar, BBQ sauce & marinades, mustard, ketchup, pickles, olives & peppers, mole, menudo & pozole, taco shells & tostadas, enchilada sauce, nacho cheese, hot sauce, salsa, canned jalapenos & chipotle; fresh tortilla endcap", order:20, kind:"aisle", qr:"RZN-LINDSAY-1B" },
  { code:"2", aisle:"2", name:"Household, paper, pet, baby care", contents:"Charcoal & fire logs, candles, laundry, dryer sheets, cleaners & bleach, trash bags, foil & wrap, air freshener, pest control, soap, dish & dishwasher, sponges, mops & brooms, shampoo, pet food, diapers, toilet paper, paper towels, napkins, plates & cups", order:30, kind:"aisle", qr:"RZN-LINDSAY-2" },
  { code:"3", aisle:"3", name:"Baking, oil, cereal, breakfast, spices, baby food", contents:"Chocolate chips & baking, marshmallows, condensed & coconut milk, sugar & sweeteners, cooking oil & spray, gelatin & pudding, cereal, breakfast bars & Pop-Tarts, oatmeal & granola, syrup & pancake mix, cake & brownie mix, baby food & Nido, spices & salt, lard", order:40, kind:"aisle", qr:"RZN-LINDSAY-3" },
  { code:"4", aisle:"4", name:"Canned veg & beans, rice, pasta, sauce", contents:"Canned vegetables & beans, hominy, mac & cheese, rice, dry pasta, pasta sauce, pesto & parmesan", order:50, kind:"aisle", qr:"RZN-LINDSAY-4" },
  { code:"5", aisle:"5", name:"Cookies, drink mixes, juice, canned fruit, coffee", contents:"Cookies (Mexican & US), powdered drink mixes, shelf juice, Clamato & V8, canned fruit, coffee & creamer", order:60, kind:"aisle", qr:"RZN-LINDSAY-5" },
  { code:"6A", aisle:"6", name:"Snacks & beverages", contents:"Nuts & trail mix, popcorn, chips & candy, water & sparkling, sports & energy drinks, AriZona, 2L soda", order:70, kind:"aisle", qr:"RZN-LINDSAY-6A" },
  { code:"6B", aisle:"6", name:"Wine, frozen desserts, single-serve soda doors", contents:"Wine, ice cream & frozen treats, cheesecakes, whipped topping, ice cream cakes, pies; 10 doors single-serve soda", order:80, kind:"aisle", qr:"RZN-LINDSAY-6B" },
  { code:"PR", aisle:"Produce", name:"Produce", contents:"Produce", order:90, kind:"perimeter", qr:"RZN-LINDSAY-PR" },
  { code:"MT", aisle:"Meat", name:"Meat case", contents:"Meat case", order:100, kind:"perimeter", qr:"RZN-LINDSAY-MT" },
  { code:"BR", aisle:"Beer", name:"Beer", contents:"Beer", order:110, kind:"perimeter", qr:"RZN-LINDSAY-BR" }
];

// ── helpers ───────────────────────────────────────────────────
function ptParts(d) {
  d = d || new Date();
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false, weekday:"short" });
  const p = {};
  f.formatToParts(d).forEach(x => { p[x.type] = x.value; });
  const wd = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }[p.weekday];
  return { date:`${p.year}-${p.month}-${p.day}`, hour:parseInt(p.hour,10)%24, minute:parseInt(p.minute,10), weekday:wd };
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0,10);
}
function weekdayOf(dateStr) { return new Date(dateStr + "T12:00:00Z").getUTCDay(); }
function esc(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function fmtTime(ts) {
  if (!ts) return "";
  try { return new Date(ts).toLocaleTimeString("en-US", { timeZone:TZ, hour:"numeric", minute:"2-digit" }); } catch (e) { return ""; }
}
function normQr(s) {
  const up = String(s || "").toUpperCase();
  const m = up.match(/RZN-[A-Z]+-[A-Z0-9]+/);
  return m ? m[0] : up.trim();
}
function seededPick(seed, items, k) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => {
    h = (h + 0x6D2B79F5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr.slice(0, k);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Telegram ──────────────────────────────────────────────────
function botToken() { return process.env.TELEGRAM_BOT_TOKEN || ""; }

function tgApi(method, payload, timeoutMs) {
  return new Promise(resolve => {
    if (!botToken()) return resolve({ ok:false, error:"no token" });
    const data = JSON.stringify(payload || {});
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${botToken()}/${method}`,
      method: "POST",
      headers: { "Content-Type":"application/json", "Content-Length":Buffer.byteLength(data) },
    }, res => {
      let raw = "";
      res.on("data", c => { raw += c; });
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve({ ok:false, error:"bad response" }); } });
    });
    req.on("error", e => resolve({ ok:false, error:e.message }));
    req.setTimeout(timeoutMs || 35000, () => { req.destroy(); resolve({ ok:false, error:"timeout" }); });
    req.write(data);
    req.end();
  });
}

function chunkText(text, size) {
  const out = [];
  let cur = "";
  for (const line of String(text).split("\n")) {
    if ((cur + "\n" + line).length > size) { if (cur) out.push(cur); cur = line; }
    else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = function raziModules(app, pool) {
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { console.error(`${req.method} ${req.path}:`, e.message); res.status(500).json({ error: e.message }); }
  };

  // ── Telegram senders ────────────────────────────────────────
  async function chatIds() {
    try { return (await pool.query("SELECT chat_id FROM telegram_chats")).rows.map(r => r.chat_id); }
    catch (e) { return []; }
  }
  async function sendTo(chatId, text) {
    let ok = true;
    for (const part of chunkText(text, 3800)) {
      const r = await tgApi("sendMessage", { chat_id: chatId, text: part, parse_mode: "HTML", disable_web_page_preview: true });
      if (!r.ok) { ok = false; console.error("telegram send failed:", r.error || r.description); }
    }
    return ok;
  }
  async function notifyRaz(text) {
    if (!botToken()) return false;
    const ids = await chatIds();
    if (!ids.length) return false;
    let any = false;
    for (const id of ids) { if (await sendTo(id, text)) any = true; }
    return any;
  }

  // ── Schema ──────────────────────────────────────────────────
  async function init() {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_meta (
          key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS day_runs (
          store         TEXT NOT NULL,
          run_date      DATE NOT NULL,
          state         JSONB DEFAULT '{}',
          steps_complete JSONB DEFAULT '[]',
          step_log      JSONB DEFAULT '{}',
          current_step  INTEGER DEFAULT 0,
          updated_by    TEXT,
          confirmed_at  TIMESTAMPTZ,
          confirmed_by  TEXT,
          confirm_note  TEXT,
          incomplete    JSONB DEFAULT '[]',
          updated_at    TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (store, run_date)
        );

        CREATE TABLE IF NOT EXISTS aisle_zones (
          store       TEXT NOT NULL,
          code        TEXT NOT NULL,
          aisle       TEXT,
          name        TEXT NOT NULL,
          contents    TEXT,
          walk_order  INTEGER DEFAULT 0,
          kind        TEXT DEFAULT 'aisle',
          qr_code     TEXT NOT NULL,
          PRIMARY KEY (store, code)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_zone_qr ON aisle_zones(qr_code);

        CREATE TABLE IF NOT EXISTS aisle_walks (
          id               SERIAL PRIMARY KEY,
          store            TEXT NOT NULL,
          walk_date        DATE NOT NULL,
          zone_code        TEXT NOT NULL,
          clerk_name       TEXT,
          status           TEXT DEFAULT 'in_progress',
          started_at       TIMESTAMPTZ,
          ended_at         TIMESTAMPTZ,
          expired_tags_out BOOLEAN,
          missing_tags_done BOOLEAN,
          random_tpr_done  BOOLEAN,
          random_required  BOOLEAN DEFAULT FALSE,
          notes            TEXT,
          method           TEXT DEFAULT 'qr',
          UNIQUE (store, walk_date, zone_code)
        );

        CREATE TABLE IF NOT EXISTS tpr_decisions (
          id           SERIAL PRIMARY KEY,
          store        TEXT NOT NULL,
          run_date     DATE NOT NULL,
          item_key     TEXT NOT NULL,
          upc          TEXT,
          description  TEXT NOT NULL,
          decision     TEXT NOT NULL,
          near_expiry  BOOLEAN DEFAULT FALSE,
          overstock    BOOLEAN DEFAULT FALSE,
          reason       TEXT,
          new_end_date DATE,
          extended_in_brdata BOOLEAN DEFAULT FALSE,
          clerk_name   TEXT,
          created_at   TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (store, run_date, item_key)
        );

        CREATE TABLE IF NOT EXISTS verify_tasks (
          id           SERIAL PRIMARY KEY,
          store        TEXT NOT NULL,
          upc          TEXT NOT NULL,
          description  TEXT,
          dept         TEXT,
          aisle        TEXT,
          qty          INTEGER,
          retail       NUMERIC(10,2),
          sale_price   NUMERIC(10,2),
          expiry_date  DATE,
          days_left    INTEGER,
          status       TEXT DEFAULT 'open',
          outcome_qty  INTEGER,
          note         TEXT,
          clerk_name   TEXT,
          created_at   TIMESTAMPTZ DEFAULT NOW(),
          resolved_at  TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_verify_store ON verify_tasks(store, status);

        CREATE TABLE IF NOT EXISTS manager_tasks (
          id           SERIAL PRIMARY KEY,
          store        TEXT NOT NULL,
          text         TEXT NOT NULL,
          priority     TEXT DEFAULT 'normal',
          assigned_to  TEXT,
          created_by   TEXT DEFAULT 'Raz',
          created_at   TIMESTAMPTZ DEFAULT NOW(),
          status       TEXT DEFAULT 'open',
          done_by      TEXT,
          done_at      TIMESTAMPTZ,
          note         TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_mtasks_store ON manager_tasks(store, status);

        CREATE TABLE IF NOT EXISTS daily_flags (
          store     TEXT NOT NULL,
          flag_date DATE NOT NULL,
          flag      TEXT NOT NULL,
          sent_at   TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (store, flag_date, flag)
        );

        CREATE TABLE IF NOT EXISTS telegram_chats (
          chat_id    TEXT PRIMARY KEY,
          name       TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      for (const z of LINDSAY_ZONES) {
        await pool.query(
          `INSERT INTO aisle_zones (store,code,aisle,name,contents,walk_order,kind,qr_code)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (store, code) DO NOTHING`,
          [DEFAULT_STORE, z.code, z.aisle, z.name, z.contents, z.order, z.kind, z.qr]
        );
      }

      // Scheduled alerts start the day AFTER first deploy so nothing fires on install night
      const m = await pool.query("SELECT value FROM app_meta WHERE key='alerts_from'");
      if (!m.rows.length) {
        await pool.query("INSERT INTO app_meta (key,value) VALUES ('alerts_from',$1)", [addDays(ptParts().date, 1)]);
      }
      console.log("Razi-Nova modules ready");
    } catch (e) {
      console.error("Razi-Nova modules init FAILED (core API still running):", e.message);
    }
    startTelegramPolling().catch(e => console.error("telegram loop stopped:", e.message));
    setInterval(() => { tick().catch(e => console.error("tick:", e.message)); }, 60000);
  }

  // ── Zones + walk helpers ────────────────────────────────────
  async function zonesFor(store) {
    return (await pool.query("SELECT * FROM aisle_zones WHERE store=$1 ORDER BY walk_order, code", [store])).rows;
  }
  function randomZoneCodes(date, zones) {
    const k = weekdayOf(date) === 4 ? 4 : 2; // Thursday = random-TPR day
    return seededPick(date, zones.map(z => z.code), Math.min(k, zones.length));
  }

  // ── DAY RUN ─────────────────────────────────────────────────
  app.get("/api/dayrun", wrap(async (req, res) => {
    const store = req.query.store || DEFAULT_STORE;
    const date = ptParts().date;
    const r = await pool.query("SELECT * FROM day_runs WHERE store=$1 AND run_date=$2", [store, date]);
    if (!r.rows.length) return res.json({ found:false, date });
    const row = r.rows[0];
    res.json({
      found:true, date, state:row.state || {}, stepsComplete:row.steps_complete || [], stepLog:row.step_log || {},
      currentStep:row.current_step, updatedBy:row.updated_by, updatedAt:row.updated_at,
      confirmedAt:row.confirmed_at, confirmedBy:row.confirmed_by,
    });
  }));

  app.put("/api/dayrun", wrap(async (req, res) => {
    const { store = DEFAULT_STORE, clerkName, state, stepsComplete, currentStep } = req.body || {};
    if (!clerkName) return res.status(400).json({ error:"clerkName required" });
    const date = ptParts().date;
    const done = Array.isArray(stepsComplete) ? stepsComplete : [];
    const existing = await pool.query("SELECT step_log FROM day_runs WHERE store=$1 AND run_date=$2", [store, date]);
    const log = (existing.rows[0] && existing.rows[0].step_log) || {};
    const now = new Date().toISOString();
    done.forEach(i => { if (!log[i]) log[i] = { by:clerkName, at:now }; });
    Object.keys(log).forEach(i => { if (!done.includes(Number(i))) delete log[i]; });
    await pool.query(
      `INSERT INTO day_runs (store,run_date,state,steps_complete,step_log,current_step,updated_by,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (store,run_date) DO UPDATE SET
         state=EXCLUDED.state, steps_complete=EXCLUDED.steps_complete, step_log=EXCLUDED.step_log,
         current_step=EXCLUDED.current_step, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [store, date, JSON.stringify(state || {}), JSON.stringify(done), JSON.stringify(log), Number(currentStep) || 0, clerkName]
    );
    res.json({ ok:true, savedAt:now });
  }));

  app.post("/api/dayrun/confirm", wrap(async (req, res) => {
    const { store = DEFAULT_STORE, clerkName, note = "", incomplete = [] } = req.body || {};
    if (!clerkName) return res.status(400).json({ error:"clerkName required" });
    const date = ptParts().date;
    await pool.query(
      `INSERT INTO day_runs (store,run_date,confirmed_at,confirmed_by,confirm_note,incomplete,updated_by,updated_at)
       VALUES ($1,$2,NOW(),$3,$4,$5,$3,NOW())
       ON CONFLICT (store,run_date) DO UPDATE SET
         confirmed_at=NOW(), confirmed_by=$3, confirm_note=$4, incomplete=$5, updated_at=NOW()`,
      [store, date, clerkName, String(note).slice(0, 500), JSON.stringify(incomplete)]
    );
    // Send the end-of-day report now (once)
    let sent = false;
    const already = await pool.query("SELECT 1 FROM daily_flags WHERE store=$1 AND flag_date=$2 AND flag='report'", [store, date]);
    if (!already.rows.length) {
      const rep = await buildReport(store, date);
      sent = await notifyRaz(rep.text);
      if (sent) await pool.query("INSERT INTO daily_flags (store,flag_date,flag) VALUES ($1,$2,'report') ON CONFLICT DO NOTHING", [store, date]);
    }
    res.json({ ok:true, reportSent:sent });
  }));

  app.get("/api/dayrun/report", wrap(async (req, res) => {
    const store = req.query.store || DEFAULT_STORE;
    const date = req.query.date || ptParts().date;
    const rep = await buildReport(store, date);
    const plain = rep.text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    res.json({ data:rep.data, text:plain });
  }));

  app.post("/api/dayrun/test-alert", wrap(async (req, res) => {
    const { store = DEFAULT_STORE, kind = "report" } = req.body || {};
    const date = ptParts().date;
    const connected = (await chatIds()).length > 0;
    if (!botToken()) return res.json({ ok:false, reason:"TELEGRAM_BOT_TOKEN is not set in Railway" });
    if (!connected) return res.json({ ok:false, reason:"Open the bot in Telegram and tap Start first" });
    let text;
    if (kind === "missed") text = (await missedAlertText(store, date, true)) || "✅ Test: every aisle is walked — no missed-aisle alert would be sent.";
    else text = (await buildReport(store, date)).text;
    const sent = await notifyRaz("🧪 <b>TEST</b>\n" + text);
    res.json({ ok:sent, reason: sent ? "" : "Telegram send failed — check the token" });
  }));

  // ── AISLE WALK ──────────────────────────────────────────────
  app.get("/api/walk/today", wrap(async (req, res) => {
    const store = req.query.store || DEFAULT_STORE;
    const date = ptParts().date;
    const zones = await zonesFor(store);
    const walks = (await pool.query("SELECT * FROM aisle_walks WHERE store=$1 AND walk_date=$2", [store, date])).rows;
    const rnd = randomZoneCodes(date, zones);
    const out = zones.map(z => {
      const w = walks.find(x => x.zone_code === z.code);
      return {
        code:z.code, aisle:z.aisle, name:z.name, contents:z.contents, order:z.walk_order, kind:z.kind,
        randomRequired: rnd.includes(z.code),
        status: w ? w.status : "todo",
        clerk: w ? w.clerk_name : null,
        startedAt: w ? w.started_at : null, endedAt: w ? w.ended_at : null,
        expiredOut: w ? w.expired_tags_out : null, missingDone: w ? w.missing_tags_done : null,
        randomTpr: w ? w.random_tpr_done : null, notes: w ? w.notes : null, method: w ? w.method : null,
      };
    });
    res.json({
      date, zones:out, minSeconds:MIN_AISLE_SEC,
      summary:{ total:out.length, done:out.filter(z => z.status === "done").length, inProgress:out.filter(z => z.status === "in_progress").length },
    });
  }));

  app.post("/api/walk/start", wrap(async (req, res) => {
    const { store = DEFAULT_STORE, scannedCode, clerkName } = req.body || {};
    if (!scannedCode) return res.status(400).json({ error:"scannedCode required" });
    const date = ptParts().date;
    const code = normQr(scannedCode);
    const z = (await pool.query("SELECT * FROM aisle_zones WHERE store=$1 AND qr_code=$2", [store, code])).rows[0];
    if (!z) return res.status(404).json({ error:"unknown_code", message:`"${code}" is not an aisle QR for this store` });
    const zones = await zonesFor(store);
    const rnd = randomZoneCodes(date, zones).includes(z.code);
    await pool.query(
      `INSERT INTO aisle_walks (store,walk_date,zone_code,clerk_name,status,started_at,random_required)
       VALUES ($1,$2,$3,$4,'in_progress',NOW(),$5)
       ON CONFLICT (store,walk_date,zone_code) DO NOTHING`,
      [store, date, z.code, clerkName || null, rnd]
    );
    const w = (await pool.query("SELECT * FROM aisle_walks WHERE store=$1 AND walk_date=$2 AND zone_code=$3", [store, date, z.code])).rows[0];
    res.json({ ok:true, zone:{ code:z.code, aisle:z.aisle, name:z.name, contents:z.contents, randomRequired:rnd }, status:w.status, startedAt:w.started_at });
  }));

  app.post("/api/walk/finish", wrap(async (req, res) => {
    const { store = DEFAULT_STORE, zone, scannedCode, clerkName, expiredOut, missingDone, randomTpr, notes = "" } = req.body || {};
    if (!zone || !scannedCode) return res.status(400).json({ error:"zone and scannedCode required" });
    const date = ptParts().date;
    const z = (await pool.query("SELECT * FROM aisle_zones WHERE store=$1 AND code=$2", [store, zone])).rows[0];
    if (!z) return res.status(404).json({ error:"unknown_zone" });
    if (normQr(scannedCode) !== z.qr_code) return res.status(400).json({ error:"wrong_code", message:`That QR is not for ${z.name}` });
    const w = (await pool.query("SELECT *, EXTRACT(EPOCH FROM (NOW()-started_at)) AS secs FROM aisle_walks WHERE store=$1 AND walk_date=$2 AND zone_code=$3", [store, date, zone])).rows[0];
    if (!w) return res.status(400).json({ error:"not_started", message:"Scan the aisle QR to start first" });
    if (w.status === "done") return res.json({ ok:true, already:true });
    const secs = Math.floor(Number(w.secs) || 0);
    if (secs < MIN_AISLE_SEC) return res.status(400).json({ error:"too_fast", wait:MIN_AISLE_SEC - secs, message:`Too fast — walk the aisle first (${MIN_AISLE_SEC - secs}s)` });
    if (typeof expiredOut !== "boolean" || typeof missingDone !== "boolean") return res.status(400).json({ error:"answers_required" });
    if (w.random_required && typeof randomTpr !== "boolean") return res.status(400).json({ error:"answers_required", message:"Answer the random TPR check" });
    const anyNo = expiredOut === false || missingDone === false || randomTpr === false;
    if (anyNo && String(notes).trim().length < 3) return res.status(400).json({ error:"note_required", message:"Add a note for every NO answer" });
    await pool.query(
      `UPDATE aisle_walks SET status='done', ended_at=NOW(), clerk_name=COALESCE($4,clerk_name),
         expired_tags_out=$5, missing_tags_done=$6, random_tpr_done=$7, notes=$8
       WHERE store=$1 AND walk_date=$2 AND zone_code=$3`,
      [store, date, zone, clerkName || null, expiredOut, missingDone, w.random_required ? randomTpr : null, String(notes).slice(0, 500)]
    );
    res.json({ ok:true });
  }));

  // Raz-only: mark an aisle walked when a QR is damaged / unreadable
  app.post("/api/walk/override", wrap(async (req, res) => {
    const { store = DEFAULT_STORE, zone, clerkName, reason = "", managerPin } = req.body || {};
    if (managerPin !== MANAGER_PIN) return res.status(403).json({ error:"wrong_pin" });
    if (!zone) return res.status(400).json({ error:"zone required" });
    const date = ptParts().date;
    await pool.query(
      `INSERT INTO aisle_walks (store,walk_date,zone_code,clerk_name,status,started_at,ended_at,method,notes)
       VALUES ($1,$2,$3,$4,'done',NOW(),NOW(),'manager_override',$5)
       ON CONFLICT (store,walk_date,zone_code) DO UPDATE SET
         status='done', ended_at=NOW(), method='manager_override', notes=$5, clerk_name=COALESCE($4,aisle_walks.clerk_name)`,
      [store, date, zone, clerkName || null, String(reason).slice(0, 300) || "QR unreadable"]
    );
    notifyRaz(`ℹ️ Aisle <b>${esc(zone)}</b> marked walked by manager override (${esc(clerkName || "clerk")}): ${esc(reason || "QR unreadable")}`).catch(() => {});
    res.json({ ok:true });
  }));

  // ── TPR CHECK ───────────────────────────────────────────────
  app.post("/api/tpr/decision", wrap(async (req, res) => {
    const { store = DEFAULT_STORE, upc = "", description, decision, nearExpiry = false, overstock = false, reason = "", newEndDate = null, clerkName } = req.body || {};
    if (!description || !["continue", "end"].includes(decision)) return res.status(400).json({ error:"description and decision (continue|end) required" });
    const date = ptParts().date;
    const key = (upc || description).toString().trim().toLowerCase().slice(0, 120);
    const r = await pool.query(
      `INSERT INTO tpr_decisions (store,run_date,item_key,upc,description,decision,near_expiry,overstock,reason,new_end_date,clerk_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (store,run_date,item_key) DO UPDATE SET
         decision=EXCLUDED.decision, near_expiry=EXCLUDED.near_expiry, overstock=EXCLUDED.overstock,
         reason=EXCLUDED.reason, new_end_date=EXCLUDED.new_end_date, clerk_name=EXCLUDED.clerk_name, created_at=NOW()
       RETURNING id`,
      [store, date, key, upc, description, decision, !!nearExpiry, !!overstock, String(reason).slice(0, 300), newEndDate || null, clerkName || null]
    );
    if (decision === "continue") {
      notifyRaz(`🏷️ <b>TPR continued</b> by ${esc(clerkName || "clerk")}: ${esc(description)}\nWhy: ${nearExpiry ? "near-expiry stock" : ""}${nearExpiry && overstock ? " + " : ""}${overstock ? "excess inventory" : ""}${reason ? " — " + esc(reason) : ""}\nNew end date: ${esc(newEndDate || "not set")}`).catch(() => {});
    }
    res.json({ ok:true, id:r.rows[0].id });
  }));

  app.patch("/api/tpr/decision/:id", wrap(async (req, res) => {
    const { extendedInBrdata } = req.body || {};
    await pool.query("UPDATE tpr_decisions SET extended_in_brdata=$2 WHERE id=$1", [req.params.id, !!extendedInBrdata]);
    res.json({ ok:true });
  }));

  app.get("/api/tpr/decisions", wrap(async (req, res) => {
    const store = req.query.store || DEFAULT_STORE;
    const date = req.query.date || ptParts().date;
    const r = await pool.query("SELECT *, to_char(new_end_date,'YYYY-MM-DD') AS end_date FROM tpr_decisions WHERE store=$1 AND run_date=$2 ORDER BY created_at", [store, date]);
    res.json({ decisions:r.rows });
  }));

  // ── VERIFY (weekly-ad / sale items held from markdown) ──────
  app.post("/api/verify/register", wrap(async (req, res) => {
    const { store = DEFAULT_STORE, items } = req.body || {};
    if (!Array.isArray(items)) return res.status(400).json({ error:"items array required" });
    let created = 0;
    for (const it of items) {
      if (!it.upc) continue;
      const dup = await pool.query(
        "SELECT 1 FROM verify_tasks WHERE store=$1 AND upc=$2 AND (status='open' OR created_at > NOW() - INTERVAL '3 days') LIMIT 1",
        [store, String(it.upc)]
      );
      if (dup.rows.length) continue;
      await pool.query(
        `INSERT INTO verify_tasks (store,upc,description,dept,aisle,qty,retail,sale_price,expiry_date,days_left)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [store, String(it.upc), it.description || "", it.dept || "", it.aisle || "", parseInt(it.qty, 10) || 1,
         Number(it.retail) || null, Number(it.salePrice) || null, it.expiryDate || null,
         Number.isFinite(Number(it.daysLeft)) ? Number(it.daysLeft) : null]
      );
      created++;
    }
    res.json({ ok:true, created });
  }));

  app.get("/api/verify/list", wrap(async (req, res) => {
    const store = req.query.store || DEFAULT_STORE;
    const r = await pool.query(
      `SELECT *, to_char(expiry_date,'YYYY-MM-DD') AS expiry_str FROM verify_tasks WHERE store=$1 AND (status='open' OR created_at > NOW() - INTERVAL '3 days')
       ORDER BY (status='open') DESC, days_left ASC NULLS LAST, id DESC`, [store]);
    res.json({ tasks:r.rows });
  }));

  app.patch("/api/verify/:id", wrap(async (req, res) => {
    const { outcome, qty, note = "", clerkName } = req.body || {};
    if (!["on_shelf", "gone", "problem"].includes(outcome)) return res.status(400).json({ error:"outcome must be on_shelf|gone|problem" });
    if (outcome === "problem" && String(note).trim().length < 3) return res.status(400).json({ error:"note required for a problem" });
    const r = await pool.query(
      `UPDATE verify_tasks SET status=$2, outcome_qty=$3, note=$4, clerk_name=$5, resolved_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id, outcome, qty === "" || qty == null ? null : parseInt(qty, 10), String(note).slice(0, 300), clerkName || null]
    );
    if (outcome === "problem" && r.rows[0]) {
      notifyRaz(`⚠️ <b>Weekly-ad item problem</b> (${esc(clerkName || "clerk")}): ${esc(r.rows[0].description)}\n${esc(note)}`).catch(() => {});
    }
    res.json({ ok:true });
  }));

  // ── MANAGER TASKS ───────────────────────────────────────────
  app.post("/api/mtasks", wrap(async (req, res) => {
    const { store = DEFAULT_STORE, text, priority = "normal", assignedTo = null } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error:"text required" });
    const r = await pool.query(
      "INSERT INTO manager_tasks (store,text,priority,assigned_to) VALUES ($1,$2,$3,$4) RETURNING *",
      [store, String(text).trim().slice(0, 300), priority === "high" ? "high" : "normal", assignedTo || null]
    );
    res.json({ ok:true, task:r.rows[0] });
  }));

  app.get("/api/mtasks", wrap(async (req, res) => {
    const store = req.query.store || DEFAULT_STORE;
    const { clerkName, scope } = req.query;
    const date = ptParts().date;
    let r;
    if (scope === "manager") {
      r = await pool.query(
        `SELECT * FROM manager_tasks WHERE store=$1 AND (status='open' OR (status='done' AND (done_at AT TIME ZONE '${TZ}')::date=$2::date))
         ORDER BY (status='open') DESC, (priority='high') DESC, id`, [store, date]);
    } else {
      r = await pool.query(
        `SELECT * FROM manager_tasks WHERE store=$1 AND status='open' AND (assigned_to IS NULL OR assigned_to='' OR LOWER(assigned_to)=LOWER($2))
         ORDER BY (priority='high') DESC, id`, [store, clerkName || ""]);
    }
    res.json({ tasks:r.rows });
  }));

  app.patch("/api/mtasks/:id", wrap(async (req, res) => {
    const { done, cancelled, clerkName, note = "" } = req.body || {};
    if (cancelled) await pool.query("UPDATE manager_tasks SET status='cancelled' WHERE id=$1", [req.params.id]);
    else if (done === true) await pool.query("UPDATE manager_tasks SET status='done', done_by=$2, done_at=NOW(), note=$3 WHERE id=$1", [req.params.id, clerkName || null, String(note).slice(0, 300)]);
    else if (done === false) await pool.query("UPDATE manager_tasks SET status='open', done_by=NULL, done_at=NULL WHERE id=$1", [req.params.id]);
    res.json({ ok:true });
  }));

  // ── TELEGRAM STATUS ─────────────────────────────────────────
  app.get("/api/telegram/status", wrap(async (req, res) => {
    res.json({ tokenSet: !!botToken(), connected: (await chatIds()).length > 0, cutoffHour:CUTOFF_HOUR, reportHour:REPORT_HOUR });
  }));

  // ── REPORT BUILDER ──────────────────────────────────────────
  async function missedAlertText(store, date, force) {
    const zones = await zonesFor(store);
    if (!zones.length) return null;
    const walks = (await pool.query("SELECT zone_code, status FROM aisle_walks WHERE store=$1 AND walk_date=$2", [store, date])).rows;
    const missed = zones.filter(z => { const w = walks.find(x => x.zone_code === z.code); return !w || w.status !== "done"; });
    if (!missed.length) return null;
    const run = (await pool.query("SELECT 1 FROM day_runs WHERE store=$1 AND run_date=$2", [store, date])).rows.length > 0;
    const lines = missed.map(z => `• ${esc(z.name)} (${esc(z.code)})`).join("\n");
    return `🚨 <b>Missed aisles — ${esc(store)}</b>\n${DAY_NAMES[weekdayOf(date)]} ${esc(date)}${run ? "" : "\n⚠️ No shift was started in Razi-Nova today."}\n\n${missed.length} of ${zones.length} aisles NOT walked:\n${lines}`;
  }

  async function buildReport(store, date) {
    const q = (sql, p) => pool.query(sql, p).then(r => r.rows);
    const run = (await q("SELECT * FROM day_runs WHERE store=$1 AND run_date=$2", [store, date]))[0] || null;
    const zones = await zonesFor(store);
    const walks = await q("SELECT * FROM aisle_walks WHERE store=$1 AND walk_date=$2", [store, date]);
    const rnd = randomZoneCodes(date, zones);
    const tprs = await q("SELECT *, to_char(new_end_date,'YYYY-MM-DD') AS end_date FROM tpr_decisions WHERE store=$1 AND run_date=$2 ORDER BY created_at", [store, date]);
    const verifies = await q("SELECT *, to_char(expiry_date,'YYYY-MM-DD') AS expiry_str FROM verify_tasks WHERE store=$1 AND (status='open' OR created_at > NOW() - INTERVAL '3 days') ORDER BY id", [store]);
    const mtasks = await q(
      `SELECT * FROM manager_tasks WHERE store=$1 AND (status='open' OR (status='done' AND (done_at AT TIME ZONE '${TZ}')::date=$2::date)) ORDER BY id`, [store, date]);
    const labelRows = await q("SELECT state, COUNT(*)::int AS n FROM actions WHERE store=$1 AND state IN ('approved','label_ready') GROUP BY state", [store]);

    const state = (run && run.state) || {};
    const stepsDone = (run && run.steps_complete) || [];
    const stepLog = (run && run.step_log) || {};
    const batches = Array.isArray(state.batches) ? state.batches : [];
    const expiry = Array.isArray(state.expiry) ? state.expiry : [];
    const mism = Array.isArray(state.mismatches) ? state.mismatches : [];

    const walkZones = zones.map(z => {
      const w = walks.find(x => x.zone_code === z.code);
      return {
        code:z.code, name:z.name, randomRequired:rnd.includes(z.code),
        status: w ? w.status : "todo", clerk: w ? w.clerk_name : null,
        startedAt: w ? w.started_at : null, endedAt: w ? w.ended_at : null,
        expiredOut: w ? w.expired_tags_out : null, missingDone: w ? w.missing_tags_done : null,
        randomTpr: w ? w.random_tpr_done : null, notes: w ? w.notes : null, method: w ? w.method : null,
      };
    });
    const doneZones = walkZones.filter(z => z.status === "done");
    const vCount = s => verifies.filter(v => v.status === s).length;

    const data = {
      store, date, weekday: DAY_NAMES[weekdayOf(date)],
      shift: {
        started: !!run, stepLabels: STEP_LABELS, stepsComplete: stepsDone, stepLog,
        currentStep: run ? run.current_step : 0,
        confirmedAt: run ? run.confirmed_at : null, confirmedBy: run ? run.confirmed_by : null,
        note: run ? run.confirm_note : null, incomplete: run ? run.incomplete : [],
      },
      walk: { total: zones.length, done: doneZones.length, zones: walkZones, randomZones: rnd },
      tpr: { continued: tprs.filter(t => t.decision === "continue"), ended: tprs.filter(t => t.decision === "end") },
      batches: { done: batches.filter(b => b.done).length, total: batches.length, errors: batches.filter(b => b.error).length },
      expiry: {
        pulled: expiry.filter(e => e.status === "pulled").length,
        decided: expiry.filter(e => e.decision).length,
        open: expiry.filter(e => !e.decision && !e.onSale).length,
      },
      verify: { open: vCount("open"), on_shelf: vCount("on_shelf"), gone: vCount("gone"), problem: vCount("problem"), items: verifies },
      issues: { open: mism.filter(m => m.status === "open").length, resolved: mism.filter(m => m.status === "resolved").length },
      tasks: { done: mtasks.filter(t => t.status === "done").length, total: mtasks.length, items: mtasks },
      labels: { approved: (labelRows.find(r => r.state === "approved") || {}).n || 0, label_ready: (labelRows.find(r => r.state === "label_ready") || {}).n || 0 },
    };

    // ── text version (Telegram) ──
    const L = [];
    L.push(`📋 <b>Daily report — ${esc(store)}</b>`);
    L.push(`${data.weekday} ${esc(date)}`);
    L.push("");
    if (!run) L.push("⚠️ <b>No shift was started in Razi-Nova today.</b>");
    else if (data.shift.confirmedAt) L.push(`✅ Shift confirmed by <b>${esc(data.shift.confirmedBy)}</b> at ${fmtTime(data.shift.confirmedAt)}`);
    else L.push("⚠️ <b>Shift NOT confirmed</b> — clerk never pressed End of Shift");
    if (run) L.push(`Steps: ${stepsDone.length}/${STEP_LABELS.length} done` + (stepsDone.length < STEP_LABELS.length ? ` — missing: ${STEP_LABELS.filter((s, i) => !stepsDone.includes(i)).map(esc).join(", ")}` : ""));
    if (data.shift.incomplete && data.shift.incomplete.length) L.push(`Left unfinished: ${data.shift.incomplete.map(esc).join("; ")}`);
    if (data.shift.note) L.push(`Clerk note: ${esc(data.shift.note)}`);
    L.push("");
    if (zones.length) {
      L.push(`🚶 <b>Aisle walk: ${doneZones.length}/${zones.length}</b>`);
      const notWalked = walkZones.filter(z => z.status !== "done");
      if (notWalked.length) L.push(`❌ Not walked: ${notWalked.map(z => esc(z.name)).join(", ")}`);
      const noExp = doneZones.filter(z => z.expiredOut === false);
      const noMis = doneZones.filter(z => z.missingDone === false);
      const noTpr = doneZones.filter(z => z.randomTpr === false);
      L.push(`Expired tags out: ${doneZones.filter(z => z.expiredOut === true).length} yes / ${noExp.length} no`);
      L.push(`Missing tags tagged: ${doneZones.filter(z => z.missingDone === true).length} yes / ${noMis.length} no`);
      const rz = walkZones.filter(z => z.randomRequired);
      L.push(`Random TPR check (${rz.map(z => esc(z.code)).join(", ")}): ${rz.filter(z => z.randomTpr === true).length}/${rz.length} done`);
      [...noExp, ...noMis, ...noTpr].filter((z, i, a) => a.indexOf(z) === i).forEach(z => L.push(`  ⚠️ ${esc(z.name)}: ${esc(z.notes || "no note")}`));
      doneZones.filter(z => z.method === "manager_override").forEach(z => L.push(`  🔑 ${esc(z.name)}: manager override — ${esc(z.notes || "")}`));
      L.push("");
    }
    L.push(`🏷️ <b>TPR check:</b> ${data.tpr.continued.length} continued, ${data.tpr.ended.length} let end`);
    data.tpr.continued.forEach(t => L.push(`  • ${esc(t.description)} → ${esc(t.end_date || "no date")}${t.extended_in_brdata ? "" : " (not yet extended in BRdata)"}`));
    L.push(`🖥️ <b>Batches:</b> ${data.batches.done}/${data.batches.total} processed${data.batches.errors ? `, ${data.batches.errors} error(s)` : ""}`);
    L.push(`📦 <b>Expiry:</b> ${data.expiry.pulled} pulled, ${data.expiry.decided} decided, ${data.expiry.open} still open`);
    L.push(`🛒 <b>Weekly-ad holds:</b> ${data.verify.on_shelf} on shelf, ${data.verify.gone} gone, ${data.verify.problem} problem, ${data.verify.open} still to verify`);
    L.push(`💲 <b>Price issues:</b> ${data.issues.open} open, ${data.issues.resolved} resolved`);
    L.push(`🖨️ <b>Labels waiting:</b> ${data.labels.approved + data.labels.label_ready}`);
    if (mtasks.length) L.push(`📋 <b>Your tasks:</b> ${data.tasks.done}/${data.tasks.total} done`);
    return { text: L.join("\n"), data };
  }

  // ── Scheduler ───────────────────────────────────────────────
  async function flagSent(store, date, flag) {
    return (await pool.query("SELECT 1 FROM daily_flags WHERE store=$1 AND flag_date=$2 AND flag=$3", [store, date, flag])).rows.length > 0;
  }
  async function markFlag(store, date, flag) {
    await pool.query("INSERT INTO daily_flags (store,flag_date,flag) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [store, date, flag]);
  }
  async function tick() {
    const t = ptParts();
    if (t.weekday === 0) return; // Sunday off — no alerts
    const from = (await pool.query("SELECT value FROM app_meta WHERE key='alerts_from'")).rows[0];
    if (from && t.date < from.value) return;
    if (!botToken() || !(await chatIds()).length) return;
    const stores = (await pool.query("SELECT DISTINCT store FROM aisle_zones")).rows.map(r => r.store);
    for (const store of stores) {
      if (t.hour >= CUTOFF_HOUR && !(await flagSent(store, t.date, "missed"))) {
        const text = await missedAlertText(store, t.date);
        if (!text) await markFlag(store, t.date, "missed");
        else if (await notifyRaz(text)) await markFlag(store, t.date, "missed");
      }
      if (t.hour >= REPORT_HOUR && !(await flagSent(store, t.date, "report"))) {
        const rep = await buildReport(store, t.date);
        if (await notifyRaz(rep.text)) await markFlag(store, t.date, "report");
      }
    }
  }

  // ── Telegram polling (registers Raz on /start, answers /report) ──
  async function handleMessage(msg) {
    if (!msg || !msg.chat || !msg.text) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const name = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") || msg.chat.username || "";
    const known = (await chatIds()).includes(chatId);
    if (/^\/start/i.test(text)) {
      const existing = await chatIds();
      const pair = process.env.TELEGRAM_PAIR_CODE;
      const given = text.split(/\s+/)[1];
      if (!existing.length || known || (pair && given === pair)) {
        await pool.query("INSERT INTO telegram_chats (chat_id,name) VALUES ($1,$2) ON CONFLICT (chat_id) DO NOTHING", [chatId, name]);
        await sendTo(chatId, "✅ <b>Razi-Nova alerts connected.</b>\nYou will get missed-aisle alerts and the end-of-day report here.\n\nCommands: /report  /status");
      } else {
        await sendTo(chatId, "This bot is already linked to the store owner.");
      }
      return;
    }
    if (!known) return;
    if (/^\/report/i.test(text)) {
      const rep = await buildReport(DEFAULT_STORE, ptParts().date);
      await sendTo(chatId, rep.text);
    } else if (/^\/status/i.test(text)) {
      const d = ptParts().date;
      const zones = await zonesFor(DEFAULT_STORE);
      const w = (await pool.query("SELECT COUNT(*)::int AS n FROM aisle_walks WHERE store=$1 AND walk_date=$2 AND status='done'", [DEFAULT_STORE, d])).rows[0].n;
      await sendTo(chatId, `🚶 Aisles walked today: <b>${w}/${zones.length}</b>`);
    } else {
      await sendTo(chatId, "Commands: /report  /status");
    }
  }

  let polling = false;
  async function startTelegramPolling() {
    if (polling) return;
    polling = true;
    let offset = 0;
    for (;;) {
      try {
        if (!botToken()) { await sleep(60000); continue; }
        const r = await tgApi("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, 40000);
        if (!r.ok) { await sleep(10000); continue; }
        for (const u of r.result || []) {
          offset = u.update_id + 1;
          try { await handleMessage(u.message); } catch (e) { console.error("telegram msg:", e.message); }
        }
      } catch (e) {
        console.error("telegram poll:", e.message);
        await sleep(10000);
      }
    }
  }

  return { init };
};
