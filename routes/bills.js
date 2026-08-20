// ─────────────────────────────────────────────────────────
// Maintenance Bills & Payments.
//
// Flow: an admin/committee member generates bills for a month (one per
// active member, using that member's unit type's current rate) → members
// see their own bills → payments get recorded against a bill, which
// updates its status (unpaid → partial → paid) automatically.
//
// Access rules mirror the rest of the app: resident sees only their own
// bills/payments; committee/admin see and manage everyone's.
// ─────────────────────────────────────────────────────────
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, requireRole } = require('../middleware/auth');

const router = express.Router();

const VALID_PAYMENT_MODES = ['cash', 'cheque', 'online_upi', 'online_neft', 'online_imps', 'online_rtgs', 'demand_draft'];

// GET /api/bills/rates — current maintenance rates (needed by the frontend
// to show "what am I supposed to pay" even before a bill exists)
router.get('/rates', requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT financial_year, unit_type, monthly_amount, late_fee_per_month, due_day_of_month
       FROM maintenance_rates ORDER BY financial_year DESC, unit_type`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /bills/rates error:', err);
    return res.status(500).json({ error: 'Could not load rates.' });
  }
});

// GET /api/bills — list bills. resident: own only. committee/admin: everyone's,
// with optional ?financialYear=2025-26 and ?status=unpaid filters.
router.get('/', requireLogin, async (req, res) => {
  try {
    const { financialYear, status } = req.query;
    const conditions = [];
    const params = [];

    if (req.user.role === 'resident') {
      if (!req.user.memberId) return res.status(404).json({ error: 'No member record linked to this account.' });
      params.push(req.user.memberId);
      conditions.push(`b.member_id = $${params.length}`);
    }
    if (financialYear) {
      params.push(financialYear);
      conditions.push(`b.financial_year = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`b.status = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT b.id, b.financial_year, b.billing_month, b.bill_amount, b.late_fee,
              b.total_amount_due, b.due_date, b.status, b.amount_paid, b.balance_due,
              m.full_name AS member_name, m.house_number, m.unit_type
       FROM maintenance_bills b
       JOIN members m ON m.id = b.member_id
       ${whereClause}
       ORDER BY b.billing_month DESC, m.house_number`,
      params
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /bills error:', err);
    return res.status(500).json({ error: 'Could not load bills.' });
  }
});

// GET /api/bills/:id — bill detail including its payment history
router.get('/:id', requireLogin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT b.*, m.full_name AS member_name, m.house_number, m.unit_type
       FROM maintenance_bills b JOIN members m ON m.id = b.member_id WHERE b.id = $1`,
      [id]
    );
    const bill = result.rows[0];
    if (!bill) return res.status(404).json({ error: 'Bill not found.' });
    if (req.user.role === 'resident' && bill.member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only view your own bills.' });
    }

    const payments = await pool.query(
      `SELECT id, receipt_number_auto, receipt_number_manual, payment_date, amount_paid,
              payment_mode, is_verified, remarks
       FROM maintenance_payments WHERE bill_id = $1 ORDER BY payment_date DESC`,
      [id]
    );
    return res.json({ ...bill, payments: payments.rows });
  } catch (err) {
    console.error('GET /bills/:id error:', err);
    return res.status(500).json({ error: 'Could not load bill.' });
  }
});

// POST /api/bills/generate — bulk-generate this month's bills for every
// active member, using the rate in effect for their unit type. Skips
// (doesn't duplicate) any member who already has a bill for that month.
router.post('/generate', requireLogin, requireRole('super_admin', 'committee'), async (req, res) => {
  try {
    const { billingMonth, financialYear } = req.body; // billingMonth e.g. "2026-08-01"
    if (!billingMonth || !financialYear) {
      return res.status(400).json({ error: 'billingMonth and financialYear are required.' });
    }
    if (!/^\d{4}-\d{2}-01$/.test(billingMonth)) {
      return res.status(400).json({ error: 'billingMonth must be the 1st of a month, e.g. 2026-08-01.' });
    }

    const members = await pool.query(`SELECT id, unit_type FROM members WHERE is_active = TRUE`);
    const rates = await pool.query(`SELECT unit_type, monthly_amount, late_fee_per_month, due_day_of_month, id FROM maintenance_rates WHERE financial_year = $1`, [financialYear]);
    const rateByType = Object.fromEntries(rates.rows.map(r => [r.unit_type, r]));

    let generated = 0, skippedExisting = 0, skippedNoRate = 0;

    for (const m of members.rows) {
      const rate = rateByType[m.unit_type];
      if (!rate) { skippedNoRate++; continue; }

      const dueDate = `${billingMonth.slice(0, 8)}${String(rate.due_day_of_month).padStart(2, '0')}`;
      try {
        await pool.query(
          `INSERT INTO maintenance_bills
            (member_id, financial_year, billing_month, rate_id, bill_amount, total_amount_due, due_date, generated_by)
           VALUES ($1,$2,$3,$4,$5,$5,$6,$7)`,
          [m.id, financialYear, billingMonth, rate.id, rate.monthly_amount, dueDate, req.user.userId]
        );
        generated++;
      } catch (rowErr) {
        if (rowErr.code === '23505') skippedExisting++; // already has a bill for this month
        else throw rowErr;
      }
    }

    return res.json({ generated, skippedExisting, skippedNoRate, totalActiveMembers: members.rows.length });
  } catch (err) {
    console.error('POST /bills/generate error:', err);
    return res.status(500).json({ error: 'Could not generate bills.' });
  }
});

// POST /api/bills/:id/payments — record a payment against a bill.
// Validates the payment-mode-specific fields BEFORE hitting the database,
// so a resident gets a clear "you forgot the cheque number" instead of a
// raw constraint-violation error.
router.post('/:id/payments', requireLogin, requireRole('super_admin', 'committee'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id: billId } = req.params;
    const {
      amountPaid, paymentMode, paymentDate,
      chequeNumber, chequeDate, bankName, micrCode,
      demandDraftNumber, ddBankName, ddDate,
      upiTransactionId, upiApp,
      bankReferenceNumber, transferBankName,
      receiptNumberManual, billBookNumber, remarks,
    } = req.body;

    if (!amountPaid || amountPaid <= 0) return res.status(400).json({ error: 'A positive payment amount is required.' });
    if (!VALID_PAYMENT_MODES.includes(paymentMode)) return res.status(400).json({ error: 'Invalid payment mode.' });
    if (paymentMode === 'cheque' && (!chequeNumber || !chequeDate)) {
      return res.status(400).json({ error: 'Cheque number and cheque date are required for cheque payments.' });
    }
    if (paymentMode === 'online_upi' && !upiTransactionId) {
      return res.status(400).json({ error: 'UPI transaction ID is required for UPI payments.' });
    }
    if (['online_neft', 'online_imps', 'online_rtgs'].includes(paymentMode) && !bankReferenceNumber) {
      return res.status(400).json({ error: 'Bank reference number (UTR) is required for bank transfer payments.' });
    }

    await client.query('BEGIN');

    const billResult = await client.query(`SELECT * FROM maintenance_bills WHERE id = $1 FOR UPDATE`, [billId]);
    const bill = billResult.rows[0];
    if (!bill) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Bill not found.' }); }
    if (bill.status === 'paid' || bill.status === 'waived') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `This bill is already ${bill.status} — no further payment needed.` });
    }
    const remainingBalance = parseFloat(bill.total_amount_due) - parseFloat(bill.amount_paid);
    if (amountPaid > remainingBalance) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Payment of ₹${amountPaid} exceeds the remaining balance of ₹${remainingBalance.toFixed(2)}.` });
    }

    // Apply payment: late fee first, then principal (common accounting convention)
    const outstandingLateFee = parseFloat(bill.late_fee); // simplified: assumes late fee not yet partially paid down separately
    const towardsLateFee = Math.min(amountPaid, outstandingLateFee);
    const towardsPrincipal = amountPaid - towardsLateFee;
    const newAmountPaid = parseFloat(bill.amount_paid) + amountPaid;
    const newBalance = parseFloat(bill.total_amount_due) - newAmountPaid;
    const newStatus = newBalance <= 0 ? 'paid' : 'partial';

    // Auto-generate receipt number: RCP-<year>-<sequential>
    const yearNow = new Date().getFullYear();
    const seqResult = await client.query(
      `SELECT COUNT(*) + 1 AS next_seq FROM maintenance_payments WHERE receipt_number_auto LIKE $1`,
      [`RCP-${yearNow}-%`]
    );
    const receiptAuto = `RCP-${yearNow}-${String(seqResult.rows[0].next_seq).padStart(4, '0')}`;

    await client.query(
      `INSERT INTO maintenance_payments
        (bill_id, member_id, financial_year, for_month, receipt_number_auto, receipt_number_manual, bill_book_number,
         payment_date, amount_paid, amount_towards_principal, amount_towards_late_fee, balance_outstanding,
         payment_mode, cheque_number, cheque_date, bank_name, micr_code,
         demand_draft_number, dd_bank_name, dd_date, upi_transaction_id, upi_app,
         bank_reference_number, transfer_bank_name, collected_by, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,CURRENT_DATE),$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [
        billId, bill.member_id, bill.financial_year, bill.billing_month, receiptAuto, receiptNumberManual || null, billBookNumber || null,
        paymentDate || null, amountPaid, towardsPrincipal, towardsLateFee, Math.max(0, newBalance),
        paymentMode, chequeNumber || null, chequeDate || null, bankName || null, micrCode || null,
        demandDraftNumber || null, ddBankName || null, ddDate || null, upiTransactionId || null, upiApp || null,
        bankReferenceNumber || null, transferBankName || null, req.user.userId, remarks || null,
      ]
    );

    // The database's own trigger (trg_mpay_update_bill) recalculates the
    // bill's amount_paid/status from the full sum of its payments the
    // moment this INSERT commits — that's the single source of truth,
    // so we just re-read the bill fresh rather than compute it ourselves
    // a second time (which risked drifting out of sync with the trigger).
    await client.query('COMMIT');

    const updatedBill = await pool.query(`SELECT status, amount_paid, balance_due FROM maintenance_bills WHERE id = $1`, [billId]);
    return res.status(201).json({
      message: 'Payment recorded.',
      receiptNumber: receiptAuto,
      newStatus: updatedBill.rows[0].status,
      newBalance: updatedBill.rows[0].balance_due,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /bills/:id/payments error:', err);
    return res.status(500).json({ error: 'Could not record payment.' });
  } finally {
    client.release();
  }
});

module.exports = router;
