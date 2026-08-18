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
        `SELECT id, full_name, house_number, unit_type, ownership_type,
                phone_primary, email, family_size, is_active
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
      `SELECT id, full_name, house_number, unit_type, ownership_type,
              phone_primary, email, family_size, is_active
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
      fullName, houseNumber, unitType, ownershipType, ownerName,
      phonePrimary, phoneSecondary, email, familySize, moveInDate,
      vehicle1Reg, vehicle2Reg, parkingSlot,
      emergencyContactName, emergencyContactPhone,
      idProofType, idProofNumber, notes,
    } = req.body;

    if (!fullName || !houseNumber || !unitType || !phonePrimary || !moveInDate) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if ((ownershipType || 'owner') === 'tenant' && !ownerName) {
      return res.status(400).json({ error: 'Tenant records must include the property owner\'s name.' });
    }

    const result = await pool.query(
      `INSERT INTO members
        (full_name, house_number, unit_type, ownership_type, owner_name,
         phone_primary, phone_secondary, email, family_size, move_in_date,
         vehicle_1_reg, vehicle_2_reg, parking_slot,
         emergency_contact_name, emergency_contact_phone,
         id_proof_type, id_proof_number, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,1),$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        fullName, houseNumber, unitType, ownershipType || 'owner', ownerName || null,
        phonePrimary, phoneSecondary || null, email || null, familySize, moveInDate,
        vehicle1Reg || null, vehicle2Reg || null, parkingSlot || null,
        emergencyContactName || null, emergencyContactPhone || null,
        idProofType || null, idProofNumber || null, notes || null, req.user.userId,
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
        if (!row.fullName || !row.houseNumber || !row.unitType || !row.phonePrimary || !row.moveInDate) {
          throw new Error('Missing a required field (name, house number, unit type, phone, or move-in date).');
        }
        if (!['2bhk', '3bhk', 'rowhouse'].includes(row.unitType)) {
          throw new Error(`Invalid unit type "${row.unitType}" — must be 2bhk, 3bhk, or rowhouse.`);
        }
        const ownershipType = row.ownershipType || 'owner';
        if (!['owner', 'tenant'].includes(ownershipType)) {
          throw new Error(`Invalid ownership type "${ownershipType}" — must be owner or tenant.`);
        }
        if (ownershipType === 'tenant' && !row.ownerName) {
          throw new Error('Tenant rows must include an owner name.');
        }

        await pool.query(
          `INSERT INTO members
            (full_name, house_number, unit_type, ownership_type, owner_name,
             phone_primary, phone_secondary, email, family_size, move_in_date,
             vehicle_1_reg, vehicle_2_reg, parking_slot,
             emergency_contact_name, emergency_contact_phone,
             id_proof_type, id_proof_number, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,1),$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            row.fullName, row.houseNumber, row.unitType, ownershipType, row.ownerName || null,
            row.phonePrimary, row.phoneSecondary || null, row.email || null, row.familySize || null, row.moveInDate,
            row.vehicle1Reg || null, row.vehicle2Reg || null, row.parkingSlot || null,
            row.emergencyContactName || null, row.emergencyContactPhone || null,
            row.idProofType || null, row.idProofNumber || null, row.notes || null, req.user.userId,
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

module.exports = router;
