// ─────────────────────────────────────────────────────────
// Society Receivables Route
// Money the society receives OTHER than maintenance (hall/facility
// fees, donations, penalties, interest, advertising, etc.).
// Maintenance itself lives in the payment ledger.
//
// Receipt numbers are generated here (RCV-YYYY-NNNN, restarting each
// calendar year, based on the receipt date).
//
// Permissions:
//   GET            → canManage  (admin tiers, manager, committee — view)
//   POST           → canWrite   (admin tiers + manager can record)
//   PATCH / DELETE → canDelete  (administrator, president, secretary, treasurer)
// ─────────────────────────────────────────────────────────
const express = require('express');
const pool    = require('../db/pool');
const { requireLogin, canDelete, canWrite, canManage } = require('../middleware/auth');

const router = express.Router();

const VALID_PAYMENT_MODES = [
  'cash', 'cheque', 'online_upi', 'online_neft', 'online_rtgs', 'demand_draft',
];

// Creates the table if it does not exist yet. Safe to run on every startup.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS society_receivables (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      receipt_number   TEXT NOT NULL UNIQUE,
      receipt_date     DATE NOT NULL,
      category         TEXT NOT NULL,
      description      TEXT NOT NULL,
      payer_name       TEXT NOT NULL,
      house_number     TEXT,
      amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      payment_mode     expense_payment_mode NOT NULL,
      reference_number TEXT,
      financial_year   TEXT,
      received_by      TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_society_receivables_date ON society_receivables (receipt_date)`
  );
}
const schemaReady = ensureSchema().catch(err =>
  console.error('receivables: schema setup error (run add_receivables.sql manually):', err)
);

function financialYearOf(isoDate) {
  const y = parseInt(String(isoDate).slice(0, 4), 10);
  const m = parseInt(String(isoDate).slice(5, 7), 10);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

const isoDateOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

// GET /api/receivables?month=&year=&category=
router.get('/', requireLogin, canManage, async (req, res) => {
  try {
    await schemaReady;
    const { month, year, category } = req.query;
    const conditions = [];
    const params = [];
    if (year)     { params.push(parseInt(year));  conditions.push(`EXTRACT(YEAR  FROM receipt_date) = $${params.length}`); }
    if (month)    { params.push(parseInt(month)); conditions.push(`EXTRACT(MONTH FROM receipt_date) = $${params.length}`); }
    if (category) { params.push(category);        conditions.push(`category = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT id, receipt_number, receipt_date, category, description, payer_name,
              house_number, amount, payment_mode, reference_number, created_at
       FROM society_receivables
       ${where}
       ORDER BY receipt_date DESC, created_at DESC`,
      params
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /receivables error:', err);
    return res.status(500).json({ error: 'Could not load receivables.' });
  }
});

// POST /api/receivables — record a new receivable; receipt number is auto-generated
router.post('/', requireLogin, canWrite, async (req, res) => {
  const { receiptDate, category, description, payerName, houseNumber,
          amount, paymentMode, referenceNumber } = req.body;

  if (!isoDateOk(receiptDate) || !category || !description || !payerName || !amount || !paymentMode) {
    return res.status(400).json({
      error: 'Date, category, description, received-from name, amount and payment method are required.',
    });
  }
  if (!VALID_PAYMENT_MODES.includes(paymentMode)) {
    return res.status(400).json({ error: 'Invalid payment method.' });
  }
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number.' });
  }

  let client;
  try {
    await schemaReady;
    client = await pool.connect();
    await client.query('BEGIN');
    // Serialise number generation so two simultaneous saves cannot get the same number
    await client.query('SELECT pg_advisory_xact_lock(7301001)');

    const year = String(receiptDate).slice(0, 4);
    const next = await client.query(
      `SELECT COALESCE(MAX(SUBSTRING(receipt_number FROM '[0-9]+$')::int), 0) + 1 AS n
       FROM society_receivables WHERE receipt_number LIKE $1`,
      [`RCV-${year}-%`]
    );
    const receiptNumber = `RCV-${year}-${String(next.rows[0].n).padStart(4, '0')}`;

    const result = await client.query(
      `INSERT INTO society_receivables
         (receipt_number, receipt_date, category, description, payer_name, house_number,
          amount, payment_mode, reference_number, financial_year, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::expense_payment_mode,$9,$10,$11)
       RETURNING id, receipt_number, receipt_date, category, description, payer_name, amount, payment_mode`,
      [receiptNumber, receiptDate, String(category).trim(), String(description).trim(),
       String(payerName).trim(), houseNumber ? String(houseNumber).trim() : null,
       amt, paymentMode, referenceNumber ? String(referenceNumber).trim() : null,
       financialYearOf(receiptDate), String(req.user.userId)]
    );
    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Receivable recorded successfully.',
      receivable: result.rows[0],
      receiptNumber,
    });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ } }
    console.error('POST /receivables error:', err);
    return res.status(500).json({ error: `Could not save receivable: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// PATCH /api/receivables/:id — edit (administrator, president, secretary, treasurer)
router.patch('/:id', requireLogin, canDelete, async (req, res) => {
  try {
    await schemaReady;
    const cur = await pool.query(`SELECT * FROM society_receivables WHERE id = $1`, [req.params.id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Receivable not found.' });
    const r = cur.rows[0];

    const b = req.body;
    const receiptDate = b.receiptDate || String(r.receipt_date.toISOString ? r.receipt_date.toISOString() : r.receipt_date).slice(0, 10);
    if (!isoDateOk(receiptDate)) return res.status(400).json({ error: 'Invalid date.' });
    const mode = b.paymentMode || r.payment_mode;
    if (!VALID_PAYMENT_MODES.includes(mode)) return res.status(400).json({ error: 'Invalid payment method.' });
    const amt = b.amount !== undefined ? parseFloat(b.amount) : parseFloat(r.amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be a positive number.' });

    await pool.query(
      `UPDATE society_receivables SET
         receipt_date     = $1,
         category         = COALESCE($2, category),
         description      = COALESCE($3, description),
         payer_name       = COALESCE($4, payer_name),
         house_number     = $5,
         amount           = $6,
         payment_mode     = $7::expense_payment_mode,
         reference_number = $8,
         financial_year   = $9,
         updated_at       = NOW()
       WHERE id = $10`,
      [receiptDate,
       b.category ? String(b.category).trim() : null,
       b.description ? String(b.description).trim() : null,
       b.payerName ? String(b.payerName).trim() : null,
       b.houseNumber !== undefined ? (b.houseNumber ? String(b.houseNumber).trim() : null) : r.house_number,
       amt, mode,
       b.referenceNumber !== undefined ? (b.referenceNumber ? String(b.referenceNumber).trim() : null) : r.reference_number,
       financialYearOf(receiptDate), req.params.id]
    );
    return res.json({ message: 'Receivable updated.' });
  } catch (err) {
    console.error('PATCH /receivables/:id error:', err);
    return res.status(500).json({ error: `Could not update receivable: ${err.message}` });
  }
});

// DELETE /api/receivables/:id — (administrator, president, secretary, treasurer)
router.delete('/:id', requireLogin, canDelete, async (req, res) => {
  try {
    await schemaReady;
    const result = await pool.query(
      `DELETE FROM society_receivables WHERE id = $1 RETURNING receipt_number`, [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Receivable not found.' });
    return res.json({ message: `Receivable ${result.rows[0].receipt_number} deleted.` });
  } catch (err) {
    console.error('DELETE /receivables/:id error:', err);
    return res.status(500).json({ error: 'Could not delete receivable.' });
  }
});

router.schemaReady = schemaReady;
module.exports = router;
