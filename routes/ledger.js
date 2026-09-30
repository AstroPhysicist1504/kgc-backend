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
// ─────────────────────────────────────────────────────────
router.get('/', requireLogin, canManage, async (req, res) => {
  try {
    const { month, year } = req.query;
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
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT id, payment_date, payer_name, house_number, description,
              amount, payment_mode, bill_book_number, receipt_number,
              financial_year, created_at
       FROM payment_ledger
       ${where}
       ORDER BY payment_date DESC, receipt_number DESC`,
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
    } = req.body;

    if (!paymentDate || !payerName || !amount) {
      return res.status(400).json({ error: 'Date, payer name, and amount are required.' });
    }

    const d  = new Date(paymentDate);
    const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    const financialYear = `${fy}-${String(fy + 1).slice(-2)}`;

    const result = await pool.query(
      `INSERT INTO payment_ledger
        (payment_date, payer_name, house_number, description,
         amount, payment_mode, bill_book_number, receipt_number,
         financial_year, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [paymentDate, payerName, houseNumber || null,
       description || 'Maintenance', parseFloat(amount),
       normMode(paymentMode), billBookNumber || null,
       receiptNumber || null, financialYear, req.user.userId]
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
    } = req.body;

    const cur = await pool.query(`SELECT * FROM payment_ledger WHERE id = $1`, [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Entry not found.' });

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
         updated_at       = NOW()
       WHERE id = $9`,
      [paymentDate || null, payerName || null, houseNumber || null,
       description || null, amount !== undefined ? parseFloat(amount) : null,
       paymentMode ? normMode(paymentMode) : null,
       billBookNumber || null, receiptNumber || null, id]
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
