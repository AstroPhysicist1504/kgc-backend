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
const { requireLogin, canWrite, canManage, canDelete } = require('../middleware/auth');
const STAFF_ROLES = ['super_admin','president','secretary','treasurer','manager','committee'];

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
    const { financialYear, status, memberId } = req.query;
    const conditions = [];
    const params = [];

    if (!STAFF_ROLES.includes(req.user.role)) {
      if (!req.user.memberId) return res.status(404).json({ error: 'No member record linked to this account.' });
      params.push(req.user.memberId);
      conditions.push(`b.member_id = $${params.length}`);
    } else if (memberId) {
      // Staff viewing a specific member's bills (e.g. from that member's profile page)
      params.push(memberId);
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
    if (!STAFF_ROLES.includes(req.user.role) && bill.member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only view your own bills.' });
    }

    const payments = await pool.query(
      `SELECT p.id, p.receipt_number_auto, p.receipt_number_manual, p.bill_book_number,
              p.payment_date, p.amount_paid, p.amount_towards_principal, p.amount_towards_late_fee,
              p.balance_outstanding, p.payment_mode, p.is_verified, p.remarks,
              p.cheque_number, p.cheque_date, p.bank_name,
              p.demand_draft_number, p.dd_bank_name, p.dd_date,
              p.upi_transaction_id, p.upi_app,
              p.bank_reference_number, p.transfer_bank_name,
              u.display_name AS collected_by_name
       FROM maintenance_payments p
       LEFT JOIN users u ON u.id = p.collected_by
       WHERE p.bill_id = $1 ORDER BY p.payment_date DESC`,
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
router.post('/generate', requireLogin, canWrite, async (req, res) => {
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
router.post('/:id/payments', requireLogin, canWrite, async (req, res) => {
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

// ─────────────────────────────────────────────────────────
// GET /api/bills/quarterly-summary
// Returns maintenance collected and expenses per quarter
// for a given calendar year (defaults to current year).
// Quarters follow the calendar year (Jan-Mar, Apr-Jun, etc.)
// Query param: ?year=2026
// ─────────────────────────────────────────────────────────
router.get('/quarterly-summary', requireLogin, canManage, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();

    // Maintenance collected per quarter (from payments)
    const collectedRes = await pool.query(`
      SELECT
        EXTRACT(QUARTER FROM payment_date)::int AS quarter,
        COALESCE(SUM(amount_paid), 0)           AS collected
      FROM maintenance_payments
      WHERE EXTRACT(YEAR FROM payment_date) = $1
      GROUP BY quarter
      ORDER BY quarter
    `, [year]);

    // Expenses per quarter (from society_expenses)
    const expensesRes = await pool.query(`
      SELECT
        EXTRACT(QUARTER FROM expense_date)::int AS quarter,
        COALESCE(SUM(amount), 0)                AS expenses
      FROM society_expenses
      WHERE EXTRACT(YEAR FROM expense_date) = $1
      GROUP BY quarter
      ORDER BY quarter
    `, [year]);

    // Merge into 4 quarters
    const quarters = [1, 2, 3, 4].map(q => {
      const col = collectedRes.rows.find(r => r.quarter === q);
      const exp = expensesRes.rows.find(r => r.quarter === q);
      const collected = parseFloat(col?.collected || 0);
      const expenses  = parseFloat(exp?.expenses  || 0);
      return {
        quarter:   q,
        label:     ['Q1 (Jan–Mar)', 'Q2 (Apr–Jun)', 'Q3 (Jul–Sep)', 'Q4 (Oct–Dec)'][q - 1],
        collected,
        expenses,
        surplus:   collected - expenses,
      };
    });

    return res.json({ year, quarters });
  } catch (err) {
    console.error('GET /bills/quarterly-summary error:', err);
    return res.status(500).json({ error: 'Could not load quarterly summary.' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/bills/import
// Bulk-import historical maintenance bills + payments from Excel.
// Each row must have: house_number, billing_month (YYYY-MM-DD),
// financial_year, amount_due, amount_paid, payment_date, payment_mode.
// Maps house_number → member_id automatically.
// Creates the bill AND a payment record in one transaction per row.
// ─────────────────────────────────────────────────────────
router.post('/import', requireLogin, canDelete, async (req, res) => {
  try {
    const { bills } = req.body;
    if (!Array.isArray(bills) || bills.length === 0) {
      return res.status(400).json({ error: 'No rows provided.' });
    }
    if (bills.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 rows per import.' });
    }

    const succeeded = [], failed = [];

    for (let i = 0; i < bills.length; i++) {
      const r = bills[i];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Resolve member from house_number
        const memberRes = await client.query(
          `SELECT id FROM members WHERE LOWER(TRIM(house_number)) = LOWER(TRIM($1))`,
          [r.houseNumber]
        );
        if (memberRes.rows.length === 0) {
          throw new Error(`No member found with house number "${r.houseNumber}"`);
        }
        const memberId = memberRes.rows[0].id;

        // Find matching rate for the financial year + unit type
        const rateRes = await client.query(
          `SELECT r.id FROM maintenance_rates r
           JOIN members m ON m.id = $1
           WHERE r.financial_year = $2 AND r.unit_type = m.unit_type
           LIMIT 1`,
          [memberId, r.financialYear]
        );
        const rateId = rateRes.rows[0]?.id || null;

        const billingMonth = r.billingMonth; // YYYY-MM-DD
        const amountDue    = parseFloat(r.amountDue)  || 0;
        const amountPaid   = parseFloat(r.amountPaid) || 0;
        const balance      = amountDue - amountPaid;
        const status       = amountPaid <= 0       ? 'unpaid'
                           : balance <= 0           ? 'paid'
                           : 'partial';

        // Upsert the bill (skip if already exists for this member+month)
        const billRes = await client.query(
          `INSERT INTO maintenance_bills
            (member_id, financial_year, billing_month, rate_id,
             bill_amount, total_amount_due, amount_paid, balance_due,
             status, due_date, generated_by)
           VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,
                   ($3::date + interval '10 days')::date, $9)
           ON CONFLICT (member_id, billing_month) DO UPDATE
             SET amount_paid   = EXCLUDED.amount_paid,
                 balance_due   = EXCLUDED.balance_due,
                 status        = EXCLUDED.status,
                 updated_at    = NOW()
           RETURNING id`,
          [memberId, r.financialYear, billingMonth, rateId,
           amountDue, amountPaid, balance, status, req.user.userId]
        );
        const billId = billRes.rows[0].id;

        // Record payment if amount paid > 0
        if (amountPaid > 0 && r.paymentDate) {
          const mode = (r.paymentMode || 'cash').toLowerCase().trim();
          const validModes = ['cash','cheque','online_upi','online_neft','online_rtgs','demand_draft'];
          const payMode = validModes.includes(mode) ? mode : 'cash';

          await client.query(
            `INSERT INTO maintenance_payments
              (bill_id, member_id, payment_date, amount_paid,
               amount_towards_principal, balance_outstanding,
               payment_mode, collected_by, remarks)
             VALUES ($1,$2,$3,$4,$4,$5,$6::payment_mode,$7,$8)`,
            [billId, memberId, r.paymentDate, amountPaid,
             balance, payMode, req.user.userId,
             r.remarks || 'Imported from historical records']
          );
        }

        await client.query('COMMIT');
        succeeded.push(r.houseNumber);
      } catch (err) {
        await client.query('ROLLBACK');
        failed.push({ row: r.houseNumber || `Row ${i + 1}`, error: err.message });
      } finally {
        client.release();
      }
    }

    return res.json({
      successCount: succeeded.length,
      failedCount:  failed.length,
      totalRows:    bills.length,
      failed,
    });
  } catch (err) {
    console.error('POST /bills/import error:', err);
    return res.status(500).json({ error: 'Import failed.' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/bills/:id — edit a bill's amount or status
// Restricted to canDelete roles (admin, president, secretary, treasurer)
// ─────────────────────────────────────────────────────────
router.patch('/:id', requireLogin, canDelete, async (req, res) => {
  try {
    const { id } = req.params;
    const { totalAmountDue, amountPaid, status, remarks } = req.body;

    const current = await pool.query(
      `SELECT * FROM maintenance_bills WHERE id = $1`, [id]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found.' });
    }

    const due   = totalAmountDue !== undefined ? parseFloat(totalAmountDue) : parseFloat(current.rows[0].total_amount_due);
    const paid  = amountPaid     !== undefined ? parseFloat(amountPaid)     : parseFloat(current.rows[0].amount_paid);
    const bal   = due - paid;
    const newStatus = status || (paid <= 0 ? 'unpaid' : bal <= 0 ? 'paid' : 'partial');

    await pool.query(
      `UPDATE maintenance_bills SET
         total_amount_due = $1,
         amount_paid      = $2,
         balance_due      = $3,
         status           = $4,
         updated_at       = NOW()
       WHERE id = $5`,
      [due, paid, bal, newStatus, id]
    );

    return res.json({ message: 'Bill updated.' });
  } catch (err) {
    console.error('PATCH /bills/:id error:', err);
    return res.status(500).json({ error: `Could not update bill: ${err.message}` });
  }
});
