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

const router = express.Router();

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
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
