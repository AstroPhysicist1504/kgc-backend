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
      fullName, houseNumber, unitType, ownershipType,
      phonePrimary, email, familySize, moveInDate,
    } = req.body;

    if (!fullName || !houseNumber || !unitType || !phonePrimary || !moveInDate) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const result = await pool.query(
      `INSERT INTO members
        (full_name, house_number, unit_type, ownership_type, phone_primary, email, family_size, move_in_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,1),$8,$9)
       RETURNING id`,
      [fullName, houseNumber, unitType, ownershipType || 'owner', phonePrimary, email || null, familySize, moveInDate, req.user.userId]
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

module.exports = router;
