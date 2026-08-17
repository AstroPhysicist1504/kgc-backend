// ─────────────────────────────────────────────────────────
// Complaint lifecycle: open → acknowledged → in_progress → resolved → closed
// (or → rejected at any point before resolved)
//
// Access rules:
//   resident          → can raise a complaint, see ONLY their own complaints
//   committee/admin   → see ALL complaints, can update status/assign/resolve
// Every status change is logged to complaint_updates — nothing is ever
// silently overwritten, so there's always a full history of what happened.
// ─────────────────────────────────────────────────────────
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, requireRole } = require('../middleware/auth');

const router = express.Router();

const VALID_CATEGORIES = ['plumbing', 'electrical', 'lift', 'common_area', 'security', 'noise', 'parking', 'pest_control', 'other'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const VALID_STATUSES = ['open', 'acknowledged', 'in_progress', 'resolved', 'closed', 'rejected'];

// GET /api/complaints
// residents see only their own; committee/admin see everyone's
router.get('/', requireLogin, async (req, res) => {
  try {
    const baseSelect = `
      SELECT c.id, c.complaint_number, c.title, c.description, c.category,
             c.priority, c.status, c.photo_url, c.resolution_notes,
             c.resolved_at, c.resident_rating, c.resident_feedback,
             c.created_at, c.updated_at,
             m.full_name AS member_name, m.house_number,
             u.display_name AS assigned_to_name
      FROM complaints c
      JOIN members m ON m.id = c.member_id
      LEFT JOIN users u ON u.id = c.assigned_to
    `;

    if (req.user.role === 'super_admin' || req.user.role === 'committee') {
      const result = await pool.query(`${baseSelect} ORDER BY c.created_at DESC`);
      return res.json(result.rows);
    }

    if (!req.user.memberId) {
      return res.status(404).json({ error: 'No member record linked to this account.' });
    }
    const result = await pool.query(
      `${baseSelect} WHERE c.member_id = $1 ORDER BY c.created_at DESC`,
      [req.user.memberId]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /complaints error:', err);
    return res.status(500).json({ error: 'Could not load complaints.' });
  }
});

// GET /api/complaints/:id  — full detail including its status history
router.get('/:id', requireLogin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT c.*, m.full_name AS member_name, m.house_number, u.display_name AS assigned_to_name
       FROM complaints c
       JOIN members m ON m.id = c.member_id
       LEFT JOIN users u ON u.id = c.assigned_to
       WHERE c.id = $1`,
      [id]
    );
    const complaint = result.rows[0];
    if (!complaint) {
      return res.status(404).json({ error: 'Complaint not found.' });
    }
    if (req.user.role === 'resident' && complaint.member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only view your own complaints.' });
    }

    const history = await pool.query(
      `SELECT cu.id, cu.old_status, cu.new_status, cu.note, cu.created_at, u.display_name AS updated_by_name
       FROM complaint_updates cu
       LEFT JOIN users u ON u.id = cu.updated_by
       WHERE cu.complaint_id = $1
       ORDER BY cu.created_at ASC`,
      [id]
    );

    return res.json({ ...complaint, history: history.rows });
  } catch (err) {
    console.error('GET /complaints/:id error:', err);
    return res.status(500).json({ error: 'Could not load complaint.' });
  }
});

// POST /api/complaints — any logged-in resident (or staff, on a resident's behalf) can raise one
router.post('/', requireLogin, async (req, res) => {
  try {
    const { title, description, category, priority, photoUrl, memberId: bodyMemberId } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description are required.' });
    }
    if (category && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category.' });
    }
    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: 'Invalid priority.' });
    }

    // Residents can only file on their own behalf. Staff may file on behalf
    // of a member (e.g. a phone complaint logged by the office) by passing memberId.
    let memberId = req.user.memberId;
    if (req.user.role !== 'resident' && bodyMemberId) {
      memberId = bodyMemberId;
    }
    if (!memberId) {
      return res.status(400).json({ error: 'No member is associated with this complaint.' });
    }

    const result = await pool.query(
      `INSERT INTO complaints (member_id, title, description, category, priority)
       VALUES ($1, $2, $3, COALESCE($4::complaint_category, 'other'), COALESCE($5::complaint_priority, 'medium'))
       RETURNING id, complaint_number`,
      [memberId, title, description, category || null, priority || null]
    );

    if (photoUrl) {
      await pool.query(`UPDATE complaints SET photo_url = $1 WHERE id = $2`, [photoUrl, result.rows[0].id]);
    }

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /complaints error:', err);
    return res.status(500).json({ error: 'Could not submit complaint.' });
  }
});

// PATCH /api/complaints/:id/status — committee/admin only: move a complaint through its lifecycle
router.patch('/:id/status', requireLogin, requireRole('super_admin', 'committee'), async (req, res) => {
  try {
    const { id } = req.params;
    const { newStatus, note, resolutionNotes, assignedTo } = req.body;

    if (!newStatus || !VALID_STATUSES.includes(newStatus)) {
      return res.status(400).json({ error: 'Invalid or missing status.' });
    }

    const current = await pool.query(`SELECT status FROM complaints WHERE id = $1`, [id]);
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Complaint not found.' });
    }
    const oldStatus = current.rows[0].status;

    const updates = ['status = $1', 'updated_at = NOW()'];
    const params = [newStatus];
    let paramIndex = 2;

    if (newStatus === 'resolved') {
      updates.push(`resolved_at = NOW()`);
      if (resolutionNotes) {
        updates.push(`resolution_notes = $${paramIndex}`);
        params.push(resolutionNotes);
        paramIndex++;
      }
    }
    if (assignedTo) {
      updates.push(`assigned_to = $${paramIndex}`);
      params.push(assignedTo);
      paramIndex++;
    }

    params.push(id);
    await pool.query(`UPDATE complaints SET ${updates.join(', ')} WHERE id = $${paramIndex}`, params);

    // Log this change to the immutable history trail
    await pool.query(
      `INSERT INTO complaint_updates (complaint_id, updated_by, old_status, new_status, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, req.user.userId, oldStatus, newStatus, note || null]
    );

    return res.json({ message: 'Complaint status updated.', oldStatus, newStatus });
  } catch (err) {
    console.error('PATCH /complaints/:id/status error:', err);
    return res.status(500).json({ error: 'Could not update complaint status.' });
  }
});

// POST /api/complaints/:id/feedback — resident rates a resolved complaint
router.post('/:id/feedback', requireLogin, requireRole('resident'), async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, feedback } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
    }

    const result = await pool.query(`SELECT member_id, status FROM complaints WHERE id = $1`, [id]);
    const complaint = result.rows[0];
    if (!complaint) {
      return res.status(404).json({ error: 'Complaint not found.' });
    }
    if (complaint.member_id !== req.user.memberId) {
      return res.status(403).json({ error: 'You can only rate your own complaints.' });
    }
    if (complaint.status !== 'resolved' && complaint.status !== 'closed') {
      return res.status(400).json({ error: 'You can only rate a complaint after it has been resolved.' });
    }

    await pool.query(
      `UPDATE complaints SET resident_rating = $1, resident_feedback = $2 WHERE id = $3`,
      [rating, feedback || null, id]
    );

    return res.json({ message: 'Feedback recorded. Thank you.' });
  } catch (err) {
    console.error('POST /complaints/:id/feedback error:', err);
    return res.status(500).json({ error: 'Could not record feedback.' });
  }
});

module.exports = router;
