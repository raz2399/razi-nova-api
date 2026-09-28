// ═══════════════════════════════════════════════════════════════
// RAZI-NOVA ACTION ENGINE
// Price calculation, rounding, margin floors, action token states
// Standalone module — no dependencies on existing app code
// ═══════════════════════════════════════════════════════════════

// ── MARGIN FLOORS BY DEPARTMENT ───────────────────────────────
const MARGIN_FLOORS = {
  PRODUCE: 0.05,
  MEAT:    0.08,
  DAIRY:   0.08,
  DELI:    0.10,
  GROCERY: 0.12,
  FROZEN:  0.10,
  BAKERY:  0.05,
  SODA:    0.12,
  HBC:     0.15,
  DEFAULT: 0.10,
};

// ── SLIDING SCALE DISCOUNTS ────────────────────────────────────
const DISCOUNT_SCALE = [
  { maxDays: 1,  pct: 0.40, label: "40% off — expires tomorrow" },
  { maxDays: 3,  pct: 0.30, label: "30% off — 2-3 days left" },
  { maxDays: 6,  pct: 0.20, label: "20% off — 4-6 days left" },
  { maxDays: 13, pct: 0.10, label: "10% off — 7-13 days left" },
];

// ── BRDATA BATCH ASSIGNMENTS ───────────────────────────────────
const BATCHES = {
  APP_MARKDOWN: { id: "600", name: "Batch 600 — Razi-Nova Markdowns" },
  EXPIRY:       { id: "002", name: "Batch 002 — exp" },
  TPR_ROLLBACK: { id: "499", name: "Batch 499 — TPR Rollback" },
};

// ── ACTION TOKEN STATES ────────────────────────────────────────
const TOKEN_STATES = {
  FLAGGED:     { id: "flagged",     label: "Flagged",     emoji: "🔴", color: "#E03131", desc: "Needs your decision" },
  APPROVED:    { id: "approved",    label: "Approved",    emoji: "⚡", color: "#D97706", desc: "Sent to BRdata" },
  LABEL_READY: { id: "label_ready", label: "Label Ready", emoji: "🖨️", color: "#7C3AED", desc: "Ready to print" },
  ON_SHELF:    { id: "on_shelf",    label: "On Shelf",    emoji: "✅", color: "#1A9E5C", desc: "Label placed" },
  PULLED:      { id: "pulled",      label: "Pulled",      emoji: "📦", color: "#6B7280", desc: "Removed from shelf" },
  RESOLVED:    { id: "resolved",    label: "Resolved",    emoji: "💰", color: "#0E9F8E", desc: "Done" },
};

// ── ACTION TYPES ───────────────────────────────────────────────
const ACTION_TYPES = {
  MARKDOWN: { id: "markdown", label: "Markdown",      batch: BATCHES.EXPIRY,       icon: "💲" },
  TPR:      { id: "tpr",      label: "TPR Sale",      batch: BATCHES.APP_MARKDOWN, icon: "🏷️" },
  PULL:     { id: "pull",     label: "Pull & Credit", batch: null,                  icon: "📦" },
  BUNDLE:   { id: "bundle",   label: "Meal Bundle",   batch: BATCHES.APP_MARKDOWN, icon: "🍱" },
};

// ═══════════════════════════════════════════════════════════════
// PRICE ENGINE
// ═══════════════════════════════════════════════════════════════

function getMarginFloor(dept) {
  const key = (dept || "").toUpperCase().trim();
  return MARGIN_FLOORS[key] || MARGIN_FLOORS.DEFAULT;
}

function getDiscountTier(daysLeft) {
  if (daysLeft > 13) return null;
  return DISCOUNT_SCALE.find(s => daysLeft <= s.maxDays) || DISCOUNT_SCALE[DISCOUNT_SCALE.length - 1];
}

// Round DOWN to nearest $.X9
function roundToX9(price) {
  if (price <= 0) return 0;
  // Get the dollar amount floored
  const floored = Math.floor(price * 100) / 100;
  // Find the nearest .X9 below
  const cents = Math.floor(floored * 100);
  const remainder = cents % 10;
  let rounded;
  if (remainder >= 9) {
    rounded = cents - (remainder - 9);
  } else {
    rounded = cents - remainder - 1; // go to previous .X9
  }
  if (rounded < 9) rounded = 9; // minimum $0.09
  return rounded / 100;
}

function calcSuggestedPrice(item) {
  const { currentRetail, cost, dept, daysLeft } = item;

  if (!currentRetail || !cost) return null;

  const tier = getDiscountTier(daysLeft);
  if (!tier) return null;

  const floor = cost * (1 + getMarginFloor(dept));
  const raw   = currentRetail * (1 - tier.pct);
  const priceBeforeRound = Math.max(raw, floor);
  const suggested = roundToX9(priceBeforeRound);

  // If rounding took us below floor, bump up to next .X9
  const finalPrice = suggested < floor
    ? roundToX9(floor + 0.10)
    : suggested;

  const actualPct  = ((currentRetail - finalPrice) / currentRetail * 100).toFixed(0);
  const margin     = ((finalPrice - cost) / finalPrice * 100).toFixed(1);
  const customerSaves = (currentRetail - finalPrice).toFixed(2);

  return {
    suggestedPrice:  finalPrice,
    discountPct:     Number(actualPct),
    discountLabel:   tier.label,
    marginPct:       Number(margin),
    floorPrice:      Math.ceil(floor * 100) / 100,
    customerSaves:   Number(customerSaves),
    wasPrice:        currentRetail,
    tier,
    safe:            finalPrice >= floor,
  };
}

// TPR end date: expiry date - 1 day (so batch 499 rolls it back before it expires)
function suggestTPREndDate(expiryDate) {
  if (!expiryDate) return null;
  const d = new Date(expiryDate);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════
// ACTION TOKEN MACHINE
// ═══════════════════════════════════════════════════════════════

function createAction(item, actionType, pricing, tprEndDate) {
  const now = new Date().toISOString();
  return {
    id:           `RN-${Date.now()}-${item.id}`,
    itemId:       item.id,
    upc:          item.upc,
    description:  item.item || item.name,
    dept:         item.dept,
    aisle:        item.aisle,
    qty:          item.qty,
    daysLeft:     item.daysLeft,
    expiryDate:   item.expiryDate,
    currentRetail: item.currentRetail,
    cost:         item.cost || 0,

    // Action
    actionType:   actionType.id,
    actionLabel:  actionType.label,
    batch:        actionType.batch,

    // Pricing
    suggestedPrice: pricing?.suggestedPrice || null,
    discountPct:    pricing?.discountPct || null,
    marginPct:      pricing?.marginPct || null,
    floorPrice:     pricing?.floorPrice || null,
    customerSaves:  pricing?.customerSaves || null,
    finalPrice:     pricing?.suggestedPrice || null, // Raz can edit this

    // TPR
    tprStartDate:  actionType.id === "tpr" ? now.slice(0, 10) : null,
    tprEndDate:    actionType.id === "tpr" ? tprEndDate : null,

    // Token state
    state:         TOKEN_STATES.APPROVED.id,
    stateHistory:  [{ state: TOKEN_STATES.APPROVED.id, at: now }],

    // People
    approvedBy:   "Raz",
    approvedAt:   now,
    clerkId:      null,
    clerkName:    null,
    labelPrintedAt: null,
    shelfConfirmedAt: null,
    resolvedAt:   null,

    // BRdata
    batchId:      actionType.batch?.id || null,
    batchName:    actionType.batch?.name || null,
    sentToBRdata: false,
    sentAt:       null,
    brDataConfirmed: false,
  };
}

function advanceToken(action, newState, extra = {}) {
  const now = new Date().toISOString();
  return {
    ...action,
    ...extra,
    state: newState,
    stateHistory: [
      ...action.stateHistory,
      { state: newState, at: now }
    ],
  };
}

// ═══════════════════════════════════════════════════════════════
// BATCH BUILDER
// Generates BRdata-compatible batch entry data
// ═══════════════════════════════════════════════════════════════

function buildBRdataBatchEntry(action) {
  if (!action.finalPrice || !action.upc) return null;

  return {
    batchId:     action.batchId,
    batchName:   action.batchName,
    upc:         action.upc,
    description: action.description,
    dept:        action.dept,
    oldRetail:   action.currentRetail,
    newRetail:   action.finalPrice,
    discountPct: action.discountPct,
    qty:         action.qty,
    aisle:       action.aisle,
    isTpr:       action.actionType === "tpr",
    tprStart:    action.tprStartDate,
    tprEnd:      action.tprEndDate,
    actionId:    action.id,
    generatedAt: new Date().toISOString(),
    // Label data
    label: {
      upc:         action.upc,
      description: action.description,
      wasPrice:    action.currentRetail,
      nowPrice:    action.finalPrice,
      savings:     action.customerSaves,
      pct:         action.discountPct,
      expiryDate:  action.expiryDate,
      aisle:       action.aisle,
      qty:         action.qty,
      batchRef:    `RN-${action.batchId}`,
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS (for Railway API and bridge)
// ═══════════════════════════════════════════════════════════════

if (typeof module !== "undefined") {
  module.exports = {
    MARGIN_FLOORS, DISCOUNT_SCALE, BATCHES,
    TOKEN_STATES, ACTION_TYPES,
    getDiscountTier, getMarginFloor,
    roundToX9, calcSuggestedPrice,
    suggestTPREndDate, createAction,
    advanceToken, buildBRdataBatchEntry,
  };
}
