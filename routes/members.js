// ─────────────────────────────────────────────────────────
// Every route here requires login (requireLogin). Within each
// route, we further decide WHAT to return based on req.user.role —
// this is the actual permission logic, done here, not trusted from
// the frontend. This file is the template to copy for every other
// table (complaints, hall_bookings, gym_memberships, notices, etc.)
// ─────────────────────────────────────────────────────────
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/members
// super_admin / committee → see everyone
// resident                → see only their own household record
router.get('/', requireLogin, async (req, res) => {
  try {
    if (req.user.role === 'super_admin' || req.user.role === 'committee') {
      const result = await pool.query(
        `SELECT id, full_name, house_number, unit_type,
                phone_primary, email, is_active
         FROM members
         ORDER BY house_number`
      );
      return res.json(result.rows);
    }

    // resident: only their own record
    if (!req.user.memberId) {
      return res.status(404).json({ error: 'No member record linked to this account.' });
    }
    const result = await pool.query(
      `SELECT id, full_name, house_number, unit_type,
              phone_primary, email, is_active
       FROM members WHERE id = $1`,
      [req.user.memberId]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /members error:', err);
    return res.status(500).json({ error: 'Could not load members.' });
  }
});

// GET /api/members/:id
// resident can only fetch their OWN id — enforced below, not by the URL alone
router.get('/:id', requireLogin, async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user.role === 'resident' && req.user.memberId !== id) {
      return res.status(403).json({ error: 'You can only view your own profile.' });
    }

    const result = await pool.query(`SELECT * FROM members WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found.' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /members/:id error:', err);
    return res.status(500).json({ error: 'Could not load member.' });
  }
});

// POST /api/members  — only committee/admin can add a new resident
router.post('/', requireLogin, requireRole('super_admin', 'committee'), async (req, res) => {
  try {
    const {
      fullName, houseNumber, unitType,
      phonePrimary, phoneSecondary, email,
      vehicle1Reg, vehicle2Reg,
      emergencyContactName, emergencyContactPhone,
    } = req.body;

    if (!fullName || !houseNumber || !unitType || !phonePrimary) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const result = await pool.query(
      `INSERT INTO members
        (full_name, house_number, unit_type,
         phone_primary, phone_secondary, email,
         vehicle_1_reg, vehicle_2_reg,
         emergency_contact_name, emergency_contact_phone, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        fullName, houseNumber, unitType,
        phonePrimary, phoneSecondary || null, email || null,
        vehicle1Reg || null, vehicle2Reg || null,
        emergencyContactName || null, emergencyContactPhone || null, req.user.userId,
      ]
    );

    return res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    if (err.code === '23505') { // unique_violation (duplicate house_number)
      return res.status(409).json({ error: 'A member with this house number already exists.' });
    }
    console.error('POST /members error:', err);
    return res.status(500).json({ error: 'Could not add member.' });
  }
});

// POST /api/members/import — bulk import from the Excel upload on the frontend.
// Each row is inserted independently: if one row has bad data (duplicate
// house number, invalid unit type, etc.), it's skipped and reported —
// it does NOT stop the rest of the batch from importing. You get back
// exactly which rows succeeded and which failed, and why.
router.post('/import', requireLogin, requireRole('super_admin', 'committee'), async (req, res) => {
  try {
    const { members } = req.body;
    if (!Array.isArray(members) || members.length === 0) {
      return res.status(400).json({ error: 'No member rows were provided.' });
    }
    if (members.length > 500) {
      return res.status(400).json({ error: 'Please import in batches of 500 or fewer.' });
    }

    const succeeded = [];
    const failed = [];

    for (let i = 0; i < members.length; i++) {
      const row = members[i];
      const rowLabel = row.houseNumber || `row ${i + 2}`; // +2 = accounts for header row + 1-indexing, matches what they'd see in Excel

      try {
        if (!row.fullName || !row.houseNumber || !row.unitType || !row.phonePrimary) {
          throw new Error('Missing a required field (name, house number, unit type, or phone).');
        }
        if (!['2bhk', '3bhk', 'rowhouse'].includes(row.unitType)) {
          throw new Error(`Invalid unit type "${row.unitType}" — must be 2bhk, 3bhk, or rowhouse.`);
        }

        await pool.query(
          `INSERT INTO members
            (full_name, house_number, unit_type,
             phone_primary, phone_secondary, email,
             vehicle_1_reg, vehicle_2_reg,
             emergency_contact_name, emergency_contact_phone, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            row.fullName, row.houseNumber, row.unitType,
            row.phonePrimary, row.phoneSecondary || null, row.email || null,
            row.vehicle1Reg || null, row.vehicle2Reg || null,
            row.emergencyContactName || null, row.emergencyContactPhone || null, req.user.userId,
          ]
        );
        succeeded.push(rowLabel);
      } catch (rowErr) {
        const message = rowErr.code === '23505'
          ? `House number "${row.houseNumber}" already exists.`
          : rowErr.message;
        failed.push({ row: rowLabel, error: message });
      }
    }

    return res.json({
      totalRows: members.length,
      successCount: succeeded.length,
      failedCount: failed.length,
      failed,
    });
  } catch (err) {
    console.error('POST /members/import error:', err);
    return res.status(500).json({ error: 'Import failed unexpectedly.' });
  }
});

// PUT /api/members/:id — edit an existing member's profile (committee/admin only)
router.put('/:id', requireLogin, requireRole('super_admin', 'committee'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      fullName, houseNumber, unitType,
      phonePrimary, phoneSecondary, email,
      vehicle1Reg, vehicle2Reg,
      emergencyContactName, emergencyContactPhone,
    } = req.body;

    if (!fullName || !houseNumber || !unitType || !phonePrimary) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const result = await pool.query(
      `UPDATE members SET
         full_name = $1, house_number = $2, unit_type = $3,
         phone_primary = $4, phone_secondary = $5, email = $6,
         vehicle_1_reg = $7, vehicle_2_reg = $8,
         emergency_contact_name = $9, emergency_contact_phone = $10, updated_at = NOW()
       WHERE id = $11
       RETURNING id`,
      [
        fullName, houseNumber, unitType,
        phonePrimary, phoneSecondary || null, email || null,
        vehicle1Reg || null, vehicle2Reg || null,
        emergencyContactName || null, emergencyContactPhone || null, id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found.' });
    }
    return res.json({ message: 'Member updated.', id: result.rows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Another member already has that house number.' });
    }
    console.error('PUT /members/:id error:', err);
    return res.status(500).json({ error: 'Could not update member.' });
  }
});

// PATCH /api/members/:id/active — activate or deactivate a member (committee/admin only)
// This is the SAFER way to "remove" someone who has moved out but has
// existing history (complaints, bills, bookings) — it hides them from
// active views without breaking that history's link to a real person.
router.patch('/:id/active', requireLogin, requireRole('super_admin', 'committee'), async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be true or false.' });
    }
    const result = await pool.query(
      `UPDATE members SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
      [isActive, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found.' });
    }
    return res.json({ message: isActive ? 'Member reactivated.' : 'Member marked inactive.' });
  } catch (err) {
    console.error('PATCH /members/:id/active error:', err);
    return res.status(500).json({ error: 'Could not update member status.' });
  }
});

// DELETE /api/members/:id — permanently removes a member (super_admin only).
// The database itself blocks this if the member has any existing
// complaints, bills, bookings, etc. (by design — that history shouldn't
// silently vanish). In that case, we return a clear explanation instead
// of a raw database error, and point toward deactivating instead.
router.delete('/:id', requireLogin, requireRole('super_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`DELETE FROM members WHERE id = $1 RETURNING id`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found.' });
    }
    return res.json({ message: 'Member deleted.' });
  } catch (err) {
    if (err.code === '23503') { // foreign_key_violation
      return res.status(409).json({
        error: 'This member has existing records (complaints, bills, bookings, etc.) and cannot be permanently deleted. Mark them Inactive instead to remove them from active views while preserving their history.',
      });
    }
    console.error('DELETE /members/:id error:', err);
    return res.status(500).json({ error: 'Could not delete member.' });
  }
});

// DELETE /api/members/:id/force — permanently deletes a member AND all their
// related records across every table (bills, payments, complaints, gym
// memberships, hall bookings). super_admin only.
//
// This exists specifically for cleaning up test/dummy data. For a REAL
// resident who has moved out, use PATCH /:id/active instead — that keeps
// their history intact, which is what the normal DELETE route protects by
// design. This route deliberately bypasses that protection, so it's more
// dangerous: everything happens inside one transaction, so if anything
// fails partway through, nothing is deleted at all (no half-deleted mess).
router.delete('/:id/force', requireLogin, requireRole('super_admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const memberCheck = await client.query(`SELECT full_name FROM members WHERE id = $1`, [req.params.id]);
    if (memberCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Member not found.' });
    }
    const { id } = req.params;
    const counts = {};

    // Order matters: maintenance_payments references maintenance_bills,
    // so payments must go before bills. complaint_updates cascades
    // automatically when its parent complaint is deleted.
    const payments = await client.query(`DELETE FROM maintenance_payments WHERE member_id = $1`, [id]);
    counts.payments = payments.rowCount;

    const bills = await client.query(`DELETE FROM maintenance_bills WHERE member_id = $1`, [id]);
    counts.bills = bills.rowCount;

    const complaints = await client.query(`DELETE FROM complaints WHERE member_id = $1`, [id]);
    counts.complaints = complaints.rowCount;

    const gym = await client.query(`DELETE FROM gym_memberships WHERE member_id = $1`, [id]);
    counts.gymMemberships = gym.rowCount;

    const hall = await client.query(`DELETE FROM hall_bookings WHERE member_id = $1`, [id]);
    counts.hallBookings = hall.rowCount;

    // users.member_id and members.flat_owner_member_id both auto-clear
    // (ON DELETE SET NULL), so no manual cleanup needed for those.
    await client.query(`DELETE FROM members WHERE id = $1`, [id]);

    await client.query('COMMIT');
    return res.json({
      message: `${memberCheck.rows[0].full_name} and all related records permanently deleted.`,
      deletedCounts: counts,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /members/:id/force error:', err);
    return res.status(500).json({ error: 'Force delete failed — nothing was deleted (transaction rolled back).' });
  } finally {
    client.release();
  }
});

module.exports = router;
