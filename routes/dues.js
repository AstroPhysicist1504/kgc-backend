// ─────────────────────────────────────────────────────────
// Maintenance Dues
//
// Rules (fixed for now):
//   • Maintenance charge: ₹4,000 per quarter
//   • Penalty: ₹700, applied ONCE when a quarter has ended still unpaid
//   • Financial year: Apr 1 – Mar 31
//       Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar
//   • Unpaid balances sum across quarters and across financial years
//     (carry-forward is automatic — we simply never drop old unpaid rows)
//
// A quarter's state comes from the maintenance_dues table, which an admin
// maintains by marking quarters paid/unpaid. (Later, when the payment
// ledger is linked to resident profiles, this table can be populated
// automatically instead — the computation below stays the same.)
// ─────────────────────────────────────────────────────────
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, canWrite, canManage } = require('../middleware/auth');

const router = express.Router();

const QUARTER_CHARGE = 4000;   // ₹ per quarter
const PENALTY        = 700;    // ₹ one-time, once an unpaid quarter has ended

// Quarter boundaries within a financial year starting at fyStart (Apr fyStart).
// Returns the end date (last day) of a given quarter.
function quarterEndDate(fyStart, quarter) {
  // Q1 ends Jun 30 (fyStart), Q2 Sep 30 (fyStart), Q3 Dec 31 (fyStart), Q4 Mar 31 (fyStart+1)
  const ends = {
    1: new Date(fyStart,     5, 30),  // Jun 30
    2: new Date(fyStart,     8, 30),  // Sep 30
    3: new Date(fyStart,    11, 31),  // Dec 31
    4: new Date(fyStart + 1, 2, 31),  // Mar 31
  };
  return ends[quarter];
}

// Has this quarter already ended (relative to today)?
function quarterHasEnded(fyStart, quarter) {
  return new Date() > quarterEndDate(fyStart, quarter);
}

// The current financial year's start (calendar year the FY began in)
function currentFyStart() {
  const now = new Date();
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
}

// Build the full set of quarters from the society's first FY up to the
// current quarter, so we can show every quarter that could carry a due.
function quartersUpToNow(firstFyStart) {
  const now      = new Date();
  const curFy    = currentFyStart();
  const curQ     = Math.floor(now.getMonth() / 3); // 0..3 for Jan.. but we need FY quarter
  // FY quarter of the current month: Apr-Jun=1 ... Jan-Mar=4
  const m = now.getMonth(); // 0=Jan
  const curFyQuarter = (m >= 3 && m <= 5) ? 1 : (m >= 6 && m <= 8) ? 2 : (m >= 9 && m <= 11) ? 3 : 4;

  const out = [];
  for (let fy = firstFyStart; fy <= curFy; fy++) {
    const lastQ = (fy === curFy) ? curFyQuarter : 4;
    for (let q = 1; q <= lastQ; q++) out.push({ fyStart: fy, quarter: q });
  }
  return out;
}

// Compute dues for one member given their paid-quarter map.
// paidSet is a Set of "fyStart-quarter" strings that are marked paid.
function computeMemberDues(firstFyStart, paidSet) {
  const quarters = quartersUpToNow(firstFyStart);
  let totalDue = 0, totalPenalty = 0, unpaidCount = 0;
  const breakdown = [];

  quarters.forEach(({ fyStart, quarter }) => {
    const key    = `${fyStart}-${quarter}`;
    const isPaid = paidSet.has(key);
    const ended  = quarterHasEnded(fyStart, quarter);
    // Penalty applies only to an unpaid quarter that has already ended
    const penalty = (!isPaid && ended) ? PENALTY : 0;
    const charge  = isPaid ? 0 : QUARTER_CHARGE;
    const owed    = charge + penalty;

    if (!isPaid) {
      totalDue     += charge;
      totalPenalty += penalty;
      unpaidCount  += 1;
    }
    breakdown.push({
      fyStart, quarter,
      fyLabel: `${fyStart}-${String(fyStart + 1).slice(-2)}`,
      isPaid, ended, charge, penalty, owed,
    });
  });

  return {
    totalDue,                       // unpaid maintenance only
    totalPenalty,                   // penalties only
    totalOwed: totalDue + totalPenalty,
    unpaidQuarters: unpaidCount,
    breakdown,
  };
}

// Load the first FY the society tracks. We derive it from the earliest
// move-in / member created date, falling back to 2018 (society founded).
async function getFirstFyStart() {
  try {
    const r = await pool.query(
      `SELECT MIN(EXTRACT(YEAR FROM created_at))::int AS yr FROM members`
    );
    const yr = r.rows[0]?.yr || 2018;
    return Math.max(2018, yr);
  } catch {
    return 2018;
  }
}

// ─────────────────────────────────────────────────────────
// GET /api/dues  — admin/committee: dues for every active member
// Optional ?fy=2026 to focus the grid on one financial year.
// ─────────────────────────────────────────────────────────
router.get('/', requireLogin, canManage, async (req, res) => {
  try {
    const firstFy = await getFirstFyStart();

    const membersRes = await pool.query(
      `SELECT id, full_name, house_number, unit_type
       FROM members WHERE is_active = TRUE
       ORDER BY house_number`
    );
    const duesRes = await pool.query(
      `SELECT member_id, fy_start, quarter, is_paid FROM maintenance_dues`
    );

    // Index paid quarters by member
    const paidByMember = {};
    duesRes.rows.forEach(d => {
      if (d.is_paid) {
        (paidByMember[d.member_id] = paidByMember[d.member_id] || new Set())
          .add(`${d.fy_start}-${d.quarter}`);
      }
    });

    const rows = membersRes.rows.map(m => {
      const paidSet = paidByMember[m.id] || new Set();
      const d = computeMemberDues(firstFy, paidSet);
      return {
        memberId:   m.id,
        name:       m.full_name,
        houseNumber: m.house_number,
        unitType:   m.unit_type,
        ...d,
      };
    });

    return res.json({
      quarterCharge: QUARTER_CHARGE,
      penalty:       PENALTY,
      firstFyStart:  firstFy,
      currentFyStart: currentFyStart(),
      members:       rows,
    });
  } catch (err) {
    console.error('GET /dues error:', err);
    return res.status(500).json({ error: 'Could not load dues.' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/dues/me  — a resident's own dues
// ─────────────────────────────────────────────────────────
router.get('/me', requireLogin, async (req, res) => {
  try {
    if (!req.user.memberId) {
      return res.status(404).json({ error: 'No member record linked to this account.' });
    }
    const firstFy = await getFirstFyStart();
    const duesRes = await pool.query(
      `SELECT fy_start, quarter, is_paid FROM maintenance_dues WHERE member_id = $1`,
      [req.user.memberId]
    );
    const paidSet = new Set(
      duesRes.rows.filter(d => d.is_paid).map(d => `${d.fy_start}-${d.quarter}`)
    );
    const d = computeMemberDues(firstFy, paidSet);
    return res.json({ quarterCharge: QUARTER_CHARGE, penalty: PENALTY, ...d });
  } catch (err) {
    console.error('GET /dues/me error:', err);
    return res.status(500).json({ error: 'Could not load your dues.' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/dues  — admin marks a quarter paid/unpaid for a member
// body: { memberId, fyStart, quarter, isPaid }
// canWrite = admin / president / secretary / treasurer / manager
// ─────────────────────────────────────────────────────────
router.patch('/', requireLogin, canWrite, async (req, res) => {
  try {
    const { memberId, fyStart, quarter, isPaid } = req.body;
    if (!memberId || !fyStart || !quarter || typeof isPaid !== 'boolean') {
      return res.status(400).json({ error: 'memberId, fyStart, quarter and isPaid are required.' });
    }
    if (quarter < 1 || quarter > 4) {
      return res.status(400).json({ error: 'quarter must be 1–4.' });
    }

    await pool.query(
      `INSERT INTO maintenance_dues (member_id, fy_start, quarter, is_paid, paid_on, updated_by, updated_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $4 THEN CURRENT_DATE ELSE NULL END, $5, NOW())
       ON CONFLICT (member_id, fy_start, quarter) DO UPDATE
         SET is_paid    = EXCLUDED.is_paid,
             paid_on    = CASE WHEN EXCLUDED.is_paid THEN COALESCE(maintenance_dues.paid_on, CURRENT_DATE) ELSE NULL END,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
      [memberId, fyStart, quarter, isPaid, req.user.userId]
    );

    return res.json({ message: isPaid ? 'Marked paid.' : 'Marked unpaid.' });
  } catch (err) {
    console.error('PATCH /dues error:', err);
    return res.status(500).json({ error: `Could not update: ${err.message}` });
  }
});

module.exports = router;
