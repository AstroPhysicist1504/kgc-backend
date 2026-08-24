// ─────────────────────────────────────────────────────────
// Notice Board — announcements from the committee to residents.
//
// Visibility note: the schema's notice_visibility enum also includes
// 'owners_only' and 'tenants_only', but those depended on the
// members.ownership_type column, which has since been removed from
// this app. Only 'all' and 'admin_only' are supported here — the other
// two values still exist in the database enum for future use, but
// this API doesn't offer or filter on them, to avoid silently showing
// a notice to the wrong audience.
// ─────────────────────────────────────────────────────────
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, requireRole } = require('../middleware/auth');

const router = express.Router();

const VALID_CATEGORIES = ['general', 'maintenance', 'event', 'emergency', 'finance', 'legal'];
const VALID_PRIORITIES = ['normal', 'high', 'urgent'];

// GET /api/notices — everyone sees 'all' notices; committee/admin also see 'admin_only' ones.
// Expired notices (past their expires_at) are excluded automatically.
router.get('/', requireLogin, async (req, res) => {
  try {
    const isStaff = req.user.role === 'super_admin' || req.user.role === 'committee';
    const visibilityFilter = isStaff ? `visible_to IN ('all', 'admin_only')` : `visible_to = 'all'`;

    const result = await pool.query(
      `SELECT n.id, n.title, n.body, n.category, n.priority, n.visible_to, n.is_pinned,
              n.attachment_url, n.attachment_name, n.expires_at, n.created_at, n.updated_at,
              u.display_name AS posted_by_name
       FROM notices n
       LEFT JOIN users u ON u.id = n.posted_by
       WHERE ${visibilityFilter}
         AND (n.expires_at IS NULL OR n.expires_at > NOW())
       ORDER BY n.is_pinned DESC, n.created_at DESC`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('GET /notices error:', err);
    return res.status(500).json({ error: 'Could not load notices.' });
  }
});

// POST /api/notices — committee/admin only
router.post('/', requireLogin, requireRole('super_admin', 'committee'), async (req, res) => {
  try {
    const { title, body, category, priority, visibleTo, isPinned, attachmentUrl, attachmentName, expiresAt } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body are required.' });
    }
    if (category && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category.' });
    }
    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: 'Invalid priority.' });
    }
    if (visibleTo && !['all', 'admin_only'].includes(visibleTo)) {
      return res.status(400).json({ error: 'Invalid visibility — only "all" or "admin_only" are supported.' });
    }

    const result = await pool.query(
      `INSERT INTO notices (title, body, category, priority, visible_to, is_pinned, attachment_url, attachment_name, expires_at, posted_by)
       VALUES ($1,$2,COALESCE($3::notice_category,'general'),COALESCE($4::notice_priority,'normal'),COALESCE($5::notice_visibility,'all'),COALESCE($6,FALSE),$7,$8,$9,$10)
       RETURNING id`,
      [title, body, category || null, priority || null, visibleTo || null, isPinned || false,
       attachmentUrl || null, attachmentName || null, expiresAt || null, req.user.userId]
    );
    return res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    console.error('POST /notices error:', err);
    return res.status(500).json({ error: 'Could not post notice.' });
  }
});

// PUT /api/notices/:id — committee/admin only
router.put('/:id', requireLogin, requireRole('super_admin', 'committee'), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, body, category, priority, visibleTo, isPinned, attachmentUrl, attachmentName, expiresAt } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body are required.' });
    }
    if (visibleTo && !['all', 'admin_only'].includes(visibleTo)) {
      return res.status(400).json({ error: 'Invalid visibility — only "all" or "admin_only" are supported.' });
    }

    const result = await pool.query(
      `UPDATE notices SET
         title = $1, body = $2, category = COALESCE($3, category), priority = COALESCE($4, priority),
         visible_to = COALESCE($5, visible_to), is_pinned = COALESCE($6, is_pinned),
         attachment_url = $7, attachment_name = $8, expires_at = $9, updated_at = NOW()
       WHERE id = $10 RETURNING id`,
      [title, body, category || null, priority || null, visibleTo || null, isPinned,
       attachmentUrl || null, attachmentName || null, expiresAt || null, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Notice not found.' });
    return res.json({ message: 'Notice updated.' });
  } catch (err) {
    console.error('PUT /notices/:id error:', err);
    return res.status(500).json({ error: 'Could not update notice.' });
  }
});

// DELETE /api/notices/:id — committee/admin only. No dependent records
// reference notices, so this is a plain, safe delete — no history to protect.
router.delete('/:id', requireLogin, requireRole('super_admin', 'committee'), async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM notices WHERE id = $1 RETURNING id`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Notice not found.' });
    return res.json({ message: 'Notice deleted.' });
  } catch (err) {
    console.error('DELETE /notices/:id error:', err);
    return res.status(500).json({ error: 'Could not delete notice.' });
  }
});

module.exports = router;
