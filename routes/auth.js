// ─────────────────────────────────────────────────────────
// POST /api/auth/login
// Accepts an "identifier" (email, mobile number, OR house number
// like "A-101") plus a password. Works for committee/admin accounts
// (which log in with email) and resident accounts (which may log in
// with email, phone, or their flat/house number).
// ─────────────────────────────────────────────────────────
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireLogin, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─────────────────────────────────────────────────────────
// GET /api/auth/me
// Lets the frontend restore a logged-in session after a page reload,
// since the browser only keeps the token — not who that token belongs
// to. Given a valid token, this re-fetches the current, live account
// details (so a role change, deactivation, etc. is reflected immediately
// rather than trusting whatever was true at the moment of original login).
// ─────────────────────────────────────────────────────────
router.get('/me', requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.role, u.display_name, u.email, u.is_active, u.member_id, m.house_number
       FROM users u
       LEFT JOIN members m ON m.id = u.member_id
       WHERE u.id = $1`,
      [req.user.userId]
    );
    const user = result.rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Session no longer valid. Please log in again.' });
    }
    return res.json({
      user: {
        role: user.role,
        displayName: user.display_name,
        email: user.email,
        houseNumber: user.house_number || null,
        memberId: user.member_id || null,
      },
    });
  } catch (err) {
    console.error('GET /auth/me error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Please provide both a login ID and password.' });
    }

    // Match on email, mobile, OR (via the linked member record) house_number.
    // This lets a resident log in with any of email / phone / flat number.
    const result = await pool.query(
      `SELECT u.id, u.email, u.mobile, u.password_hash, u.role, u.display_name,
              u.is_active, u.failed_login_count, u.locked_until,
              u.member_id, m.house_number
       FROM users u
       LEFT JOIN members m ON m.id = u.member_id
       WHERE u.email = $1 OR u.mobile = $1 OR m.house_number = $1
       LIMIT 1`,
      [identifier.trim()]
    );

    const user = result.rows[0];

    // Deliberately vague error message — never reveal whether the
    // identifier itself was valid, only whether login succeeded.
    const invalidMsg = { error: 'Incorrect login ID or password.' };

    if (!user) {
      return res.status(401).json(invalidMsg);
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'This account has been deactivated. Contact the society office.' });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(403).json({
        error: 'Too many failed attempts. This account is temporarily locked. Try again later.',
      });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      // Track failed attempts; lock the account after 5 in a row.
      const newCount = (user.failed_login_count || 0) + 1;
      const lockUntil = newCount >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null; // 15 min lock

      await pool.query(
        `UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3`,
        [newCount, lockUntil, user.id]
      );

      return res.status(401).json(invalidMsg);
    }

    // Success — reset failed attempts, record login time
    await pool.query(
      `UPDATE users
       SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    const tokenPayload = {
      userId: user.id,
      role: user.role, // 'super_admin' | 'committee' | 'resident'
      memberId: user.member_id,
      email: user.email,
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '12h',
    });

    return res.json({
      token,
      user: {
        role: user.role,
        displayName: user.display_name,
        email: user.email,
        houseNumber: user.house_number || null,
        memberId: user.member_id || null,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/change-password
// Self-service: a logged-in user changes their OWN password.
// Requires proving they know the current password first — this is
// what stops someone who merely stole a live session (an unlocked
// laptop, a leaked token) from locking the real owner out.
// ─────────────────────────────────────────────────────────
router.post('/change-password', requireLogin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Please provide your current and new password.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const result = await pool.query(`SELECT id, password_hash FROM users WHERE id = $1`, [req.user.userId]);
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    const currentMatches = await bcrypt.compare(currentPassword, user.password_hash);
    if (!currentMatches) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, user.id]);

    return res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// Admin-assisted reset for someone who's actually locked out and
// can't log in at all (so change-password isn't an option for them).
// Only super_admin / committee can call this — this is the practical
// "forgot password" flow for a small society app with no email/SMS
// service wired up: the resident contacts the office, and staff
// resets it for them here, then shares the new password directly.
// ─────────────────────────────────────────────────────────
router.post('/reset-password', requireLogin, requireRole('super_admin', 'committee'), async (req, res) => {
  try {
    const { identifier, newPassword } = req.body;

    if (!identifier || !newPassword) {
      return res.status(400).json({ error: 'Please provide the account identifier and a new password.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const result = await pool.query(
      `SELECT u.id, u.display_name
       FROM users u
       LEFT JOIN members m ON m.id = u.member_id
       WHERE u.email = $1 OR u.mobile = $1 OR m.house_number = $1
       LIMIT 1`,
      [identifier.trim()]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'No account found with that email, phone, or house number.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users
       SET password_hash = $1, failed_login_count = 0, locked_until = NULL
       WHERE id = $2`,
      [newHash, user.id]
    );

    return res.json({ message: `Password reset for ${user.display_name}.` });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
