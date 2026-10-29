// ─────────────────────────────────────────────────────────
// Payment Ledger Route
// A flat log of maintenance payments received — mirrors the
// society's handwritten register during the transition phase.
// No bill generation or due/penalty split.
// ─────────────────────────────────────────────────────────
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, canWrite, canDelete, canManage } = require('../middleware/auth');

const router = express.Router();

const VALID_MODES = ['cash','cheque','online','online_upi','online_neft','online_rtgs','demand_draft'];

// Maintenance per quarter by unit type (Rs.). Homes 4,000; shops 750.
const QUARTER_FEE_HOME = 4000;
const QUARTER_FEE_SHOP = 750;

// Each payment records how long it covers: start_quarter (1-4, within the financial
// year of the payment date) and quarters_covered (1-4; 4 = complete financial year).
// Older / imported rows have NULL here and are only checked against the yearly total.
// Safe to run on every startup.
async function ensureSchema() {
  await pool.query(`
    ALTER TABLE payment_ledger
      ADD COLUMN IF NOT EXISTS start_quarter    SMALLINT,
      ADD COLUMN IF NOT EXISTS quarters_covered SMALLINT
  `);
}
const schemaReady = ensureSchema().catch(err =>
  console.error('ledger: schema setup error (run add_payment_duration.sql manually):', err)
);

// Financial quarter of a YYYY-MM-DD date: Apr-Jun=1, Jul-Sep=2, Oct-Dec=3, Jan-Mar=4.
function quarterOfDate(isoDate) {
  const m = parseInt(String(isoDate).slice(5, 7), 10);
  if (m >= 4 && m <= 6)  return 1;
  if (m >= 7 && m <= 9)  return 2;
  if (m >= 10 && m <= 12) return 3;
  return 4;
}

// Validates the duration a recorder chose. Returns {start, count} or {error}.
// If neither value is supplied: 1 quarter, matching the payment date.
function resolveDuration(quartersCovered, startQuarter, paymentDate) {
  const noneGiven = (quartersCovered === undefined || quartersCovered === null || quartersCovered === '')
                 && (startQuarter === undefined || startQuarter === null || startQuarter === '');
  if (noneGiven) return { start: quarterOfDate(paymentDate), count: 1 };
  const count = parseInt(quartersCovered, 10);
  if (!(count >= 1 && count <= 4)) return { error: 'Duration must be between 1 quarter and the complete financial year.' };
  let start = (startQuarter === undefined || startQuarter === null || startQuarter === '')
    ? Math.min(quarterOfDate(paymentDate), 5 - count)
    : parseInt(startQuarter, 10);
  if (count === 4) start = 1;
  if (!(start >= 1 && start <= 4) || start + count - 1 > 4) {
    return { error: 'The chosen quarters must fall within one financial year.' };
  }
  return { start, count };
}

// Canonical house-number key as a SQL expression, mirroring houseKey() in the
// frontend: ignores case, spaces, hyphens/dots and leading zeros, and collapses
// block names to abbreviations (Kingston=K, Regal=R, Row House=RH).
// "Kingston - 05", "K-5" and "k 05" all become K5.
function houseKeySql(col) {
  return `regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(UPPER(COALESCE(${col}, '')), '[^A-Z0-9]', '', 'g'),
                  '^KINGSTON', 'K'),
                '^REGAL', 'R'),
              '^ROWHOUSE', 'RH'),
            '([A-Z])0+([0-9])', '\\1\\2', 'g')`;
}

// Normalise the free-form payment mode from the ledger
function normMode(val) {
  const v = String(val || '').trim().toLowerCase().replace(/\s+/g, '_');
  const map = {
    cash:'cash', cheque:'cheque', check:'cheque',
    online:'online', upi:'online_upi', online_upi:'online_upi',
    neft:'online_neft', rtgs:'online_rtgs', dd:'demand_draft',
  };
  return map[v] || 'cash';
}

// ─────────────────────────────────────────────────────────
// GET /api/ledger — list payments, optionally filtered
// ?month=08&year=2026
// ?from=2026-04-01&to=2026-06-30   (inclusive date range, used by CSV export)
// ─────────────────────────────────────────────────────────
router.get('/', requireLogin, canManage, async (req, res) => {
  try {
    await schemaReady;
    const { month, year, from, to } = req.query;
    const conditions = [];
    const params = [];

    if (year) {
      params.push(parseInt(year));
      conditions.push(`EXTRACT(YEAR FROM payment_date) = $${params.length}`);
    }
    if (month) {
      params.push(parseInt(month));
      conditions.push(`EXTRACT(MONTH FROM payment_date) = $${params.length}`);
    }
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    if (from && isoDate.test(from)) {
      params.push(from);
      conditions.push(`payment_date >= $${params.length}::date`);
    }
    if (to && isoDate.test(to)) {
      params.push(to);
      conditions.push(`payment_date <= $${params.length}::date`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // The owner name is always mapped from the current members list (via house
    // number), so renaming a member updates the ledger automatically.
    //
    // "Payment of previous dues" is flagged when either:
    //  1. the recorder gave a duration and the amount is more than that duration
    //     allows (e.g. more than one quarter's fee on a 1-quarter payment), or
    //  2. the house's running total for the financial year passes the yearly
    //     maintenance (also covers older rows that have no duration).
    // Homes pay Rs. 4,000/quarter (16,000/yr); shops Rs. 750/quarter (3,000/yr).
    const result = await pool.query(
      `WITH enriched AS (
         SELECT pl.*,
                SUM(pl.amount) OVER (
                  PARTITION BY ${houseKeySql('pl.house_number')}, pl.financial_year
                  ORDER BY pl.payment_date, pl.created_at, pl.id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS cum_amount
         FROM payment_ledger pl
       ),
       joined AS (
         SELECT e.*,
                m.full_name AS member_name, m.id AS member_id_ref,
                (CASE WHEN m.unit_type::text = 'shop' THEN ${QUARTER_FEE_SHOP}
                      ELSE ${QUARTER_FEE_HOME} END) AS quarter_fee
         FROM enriched e
         LEFT JOIN members m
           ON ${houseKeySql('m.house_number')} = ${houseKeySql('e.house_number')}
       )
       SELECT j.id, j.payment_date,
              COALESCE(j.member_name, j.payer_name) AS payer_name,
              j.house_number, j.description,
              j.amount, j.payment_mode, j.bill_book_number, j.receipt_number,
              j.financial_year, j.created_at,
              j.start_quarter, j.quarters_covered,
              j.cum_amount,
              j.member_id_ref AS member_id,
              CASE
                WHEN NULLIF(TRIM(COALESCE(j.house_number,'')),'') IS NULL THEN ''
                WHEN j.quarters_covered IS NOT NULL
                     AND j.amount > j.quarters_covered * j.quarter_fee THEN 'Payment of previous dues'
                WHEN j.cum_amount > 4 * j.quarter_fee THEN 'Payment of previous dues'
                ELSE ''
              END AS remark
       FROM joined j
       ${where.replace(/\bpayment_date\b/g, 'j.payment_date')}
       ORDER BY j.payment_date DESC, j.receipt_number DESC`,
      params
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /ledger error:', err);
    return res.status(500).json({ error: 'Could not load payment ledger.' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/ledger/summary — monthly totals for a financial year
// ?year=2026 (calendar year of FY start; returns Apr–Mar)
// ─────────────────────────────────────────────────────────
router.get('/summary', requireLogin, canManage, async (req, res) => {
  try {
    const now     = new Date();
    const thisM   = now.getMonth() + 1;
    const thisY   = now.getFullYear();
    const fyStart = req.query.year ? parseInt(req.query.year) : (thisM >= 4 ? thisY : thisY - 1);

    const startDate = `${fyStart}-04-01`;
    const endDate   = `${fyStart + 1}-03-31`;

    // Per-month totals across the FY
    const monthly = await pool.query(
      `SELECT
         EXTRACT(YEAR  FROM payment_date)::int AS year,
         EXTRACT(MONTH FROM payment_date)::int AS month,
         COUNT(*)                 AS count,
         COALESCE(SUM(amount), 0) AS total
       FROM payment_ledger
       WHERE payment_date BETWEEN $1 AND $2
       GROUP BY year, month
       ORDER BY year, month`,
      [startDate, endDate]
    );

    // FY grand total
    const fyTotal = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM payment_ledger
       WHERE payment_date BETWEEN $1 AND $2`,
      [startDate, endDate]
    );

    return res.json({
      fyStart,
      fyLabel: `${fyStart}-${String(fyStart + 1).slice(-2)}`,
      months:  monthly.rows,
      fyTotal: parseFloat(fyTotal.rows[0].total),
      fyCount: parseInt(fyTotal.rows[0].count),
    });
  } catch (err) {
    console.error('GET /ledger/summary error:', err);
    return res.status(500).json({ error: 'Could not load summary.' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/ledger — add a single payment entry
// ─────────────────────────────────────────────────────────
router.post('/', requireLogin, canWrite, async (req, res) => {
  try {
    const {
      paymentDate, payerName, houseNumber, description,
      amount, paymentMode, billBookNumber, receiptNumber,
      quartersCovered, startQuarter,
    } = req.body;

    await schemaReady;
    if (!paymentDate || !houseNumber || amount === undefined || amount === null || amount === '') {
      return res.status(400).json({ error: 'Date, house number, and amount are required.' });
    }
    const dur = resolveDuration(quartersCovered, startQuarter, paymentDate);
    if (dur.error) return res.status(400).json({ error: dur.error });

    // The owner name comes from the members list, keyed on house number.
    let ownerName = (payerName || '').trim();
    const look = await pool.query(
      `SELECT full_name, house_number FROM members
       WHERE ${houseKeySql('house_number')} = ${houseKeySql('$1::text')} LIMIT 1`,
      [houseNumber]
    );
    let canonicalHouse = houseNumber.trim();
    if (look.rows.length) {
      ownerName      = look.rows[0].full_name;
      canonicalHouse = look.rows[0].house_number;   // store as in the members list
    }
    if (!ownerName) {
      return res.status(404).json({
        error: `No member found for house number "${houseNumber}". Add the member first, or check the house number.`,
      });
    }

    const d  = new Date(paymentDate);
    const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    const financialYear = `${fy}-${String(fy + 1).slice(-2)}`;

    const result = await pool.query(
      `INSERT INTO payment_ledger
        (payment_date, payer_name, house_number, description,
         amount, payment_mode, bill_book_number, receipt_number,
         financial_year, recorded_by, start_quarter, quarters_covered)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [paymentDate, ownerName, canonicalHouse,
       description || 'Maintenance', parseFloat(amount),
       normMode(paymentMode), billBookNumber || null,
       receiptNumber || null, financialYear, req.user.userId,
       dur.start, dur.count]
    );

    return res.status(201).json({ message: 'Payment recorded.', id: result.rows[0].id });
  } catch (err) {
    console.error('POST /ledger error:', err);
    return res.status(500).json({ error: `Could not record payment: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/ledger/import — bulk import from Excel
// ─────────────────────────────────────────────────────────
router.post('/import', requireLogin, canDelete, async (req, res) => {
  try {
    const { payments } = req.body;
    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ error: 'No rows provided.' });
    }
    if (payments.length > 1000) {
      return res.status(400).json({ error: 'Maximum 1000 rows per import.' });
    }

    const succeeded = [], failed = [];

    for (let i = 0; i < payments.length; i++) {
      const r = payments[i];
      try {
        if (!r.paymentDate || !r.payerName || !r.amount) {
          throw new Error('Missing date, name, or amount');
        }
        const d  = new Date(r.paymentDate);
        const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
        const financialYear = `${fy}-${String(fy + 1).slice(-2)}`;

        await pool.query(
          `INSERT INTO payment_ledger
            (payment_date, payer_name, house_number, description,
             amount, payment_mode, bill_book_number, receipt_number,
             financial_year, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [r.paymentDate, r.payerName, r.houseNumber || null,
           r.description || 'Maintenance', parseFloat(r.amount),
           normMode(r.paymentMode), r.billBookNumber || null,
           r.receiptNumber || null, financialYear, req.user.userId]
        );
        succeeded.push(r.receiptNumber || r.payerName);
      } catch (e) {
        failed.push({ row: r.receiptNumber || r.payerName || `Row ${i + 1}`, error: e.message });
      }
    }

    return res.json({
      successCount: succeeded.length,
      failedCount:  failed.length,
      totalRows:    payments.length,
      failed,
    });
  } catch (err) {
    console.error('POST /ledger/import error:', err);
    return res.status(500).json({ error: 'Import failed.' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/ledger/:id — edit an entry (canDelete roles only)
// ─────────────────────────────────────────────────────────
router.patch('/:id', requireLogin, canDelete, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      paymentDate, payerName, houseNumber, description,
      amount, paymentMode, billBookNumber, receiptNumber,
      quartersCovered, startQuarter,
    } = req.body;

    await schemaReady;
    const cur = await pool.query(`SELECT * FROM payment_ledger WHERE id = $1`, [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Entry not found.' });

    // Keep the owner name mapped from the members list when a house number is given.
    let derivedName = payerName || null;
    let canonicalHouse = houseNumber || null;
    if (houseNumber) {
      const look = await pool.query(
        `SELECT full_name, house_number FROM members
         WHERE ${houseKeySql('house_number')} = ${houseKeySql('$1::text')} LIMIT 1`,
        [houseNumber]
      );
      if (look.rows.length) {
        derivedName    = look.rows[0].full_name;
        canonicalHouse = look.rows[0].house_number;
      }
    }

    // Recompute the financial year if the payment date moved across an FY edge,
    // so the "previous dues" running total stays grouped correctly.
    let financialYear = null;
    if (paymentDate) {
      const d  = new Date(paymentDate);
      const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
      financialYear = `${fy}-${String(fy + 1).slice(-2)}`;
    }

    // Duration: sent as numbers -> validate and store; sent as null -> keep it "not recorded"
    // (older entry); not sent at all -> leave it as it is.
    const durationSent = Object.prototype.hasOwnProperty.call(req.body, 'quartersCovered');
    let durStart = null, durCount = null;
    if (durationSent && quartersCovered !== null && quartersCovered !== '') {
      const effDate = paymentDate || String(cur.rows[0].payment_date.toISOString ? cur.rows[0].payment_date.toISOString() : cur.rows[0].payment_date).slice(0, 10);
      const dur = resolveDuration(quartersCovered, startQuarter, effDate);
      if (dur.error) return res.status(400).json({ error: dur.error });
      durStart = dur.start; durCount = dur.count;
    }

    await pool.query(
      `UPDATE payment_ledger SET
         payment_date     = COALESCE($1, payment_date),
         payer_name       = COALESCE($2, payer_name),
         house_number     = $3,
         description      = COALESCE($4, description),
         amount           = COALESCE($5, amount),
         payment_mode     = COALESCE($6, payment_mode),
         bill_book_number = $7,
         receipt_number   = $8,
         financial_year   = COALESCE($9, financial_year),
         start_quarter    = CASE WHEN $11::boolean THEN $12::smallint ELSE start_quarter END,
         quarters_covered = CASE WHEN $11::boolean THEN $13::smallint ELSE quarters_covered END,
         updated_at       = NOW()
       WHERE id = $10`,
      [paymentDate || null, derivedName, canonicalHouse,
       description || null, amount !== undefined ? parseFloat(amount) : null,
       paymentMode ? normMode(paymentMode) : null,
       billBookNumber || null, receiptNumber || null, financialYear, id,
       durationSent, durStart, durCount]
    );
    return res.json({ message: 'Entry updated.' });
  } catch (err) {
    console.error('PATCH /ledger/:id error:', err);
    return res.status(500).json({ error: `Could not update: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────
// DELETE /api/ledger/:id — canDelete roles only
// ─────────────────────────────────────────────────────────
router.delete('/:id', requireLogin, canDelete, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM payment_ledger WHERE id = $1 RETURNING id`, [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Entry not found.' });
    return res.json({ message: 'Entry deleted.' });
  } catch (err) {
    console.error('DELETE /ledger/:id error:', err);
    return res.status(500).json({ error: 'Could not delete entry.' });
  }
});

module.exports = router;
