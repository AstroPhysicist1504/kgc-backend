// ─────────────────────────────────────────────────────────
// This file is the "ID check" at the clerk's counter.
// Every protected route uses these two functions:
//
//   requireLogin        → confirms the person is logged in at all
//   requireRole('a','b') → confirms they're logged in AND hold one
//                          of the allowed roles for this action
//
// Never trust anything the frontend sends about who a user is
// (their claimed role, their member_id, etc). The only source of
// truth for "who is this?" is the JWT we ourselves issued at login,
// which is cryptographically signed and cannot be forged by the client.
// ─────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');

function requireLogin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Not logged in. No token provided.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // payload = { userId, role, memberId, email }  (set at login time)
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not logged in.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do this.' });
    }
    next();
  };
}

module.exports = { requireLogin, requireRole };
