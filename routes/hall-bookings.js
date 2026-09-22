// ─────────────────────────────────────────────────────────
// Community Hall Bookings
//
// Flow: resident submits a booking request (status = 'pending')
// → committee/admin approves or rejects it → if approved, status
// becomes 'confirmed' → after the event date passes, admin can
// mark it 'completed'.
//
// Double-booking prevention: a partial unique index on the database
// (idx_hall_no_double_booking) blocks two confirmed/pending bookings
// on the same date+slot. Cancelled and rejected bookings do NOT block
// the slot — partial index rather than a plain UNIQUE constraint.
//
// Access rules:
//   resident        → can submit for themselves; can view own bookings only
//   committee/admin → can view all; can approve, reject, cancel, complete
//
// The DB schema's hall_slot enum (morning/evening/full_day) is derived
// from the free-form start time the resident picks in the frontend:
//   start before 12:00 → 'morning'
//   12:00 – 17:00      → 'evening'
//   after 17:00        → 'full_day'
// ─────────────────────────────────────────────────────────
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, requireRole } = require('../middleware/auth');

const router = express.Router();

const VALID_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed', 'rejected'];

// Derive the DB slot enum from a "HH:MM AM/PM" start-time string.
function deriveSlot(startTime) {
  if (!startTime) return 'full_day';
  const [timePart, meridiem] = startTime.split(' ');
  let [hours] = timePart.split(':').map(Number);
  if (meridiem === 'PM' && hours !== 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;
  if (hours < 12) return 'morning';
  if (hours < 17) return 'evening';
  return 'full_day';
}

// Ensure extra columns and the partial unique index exist.
// Safe to run every startup (IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS).
async function ensureSchema() {
  await pool.query(`
    ALTER TABLE hall_bookings
      ADD COLUMN IF NOT EXISTS start_time       VARCHAR(10),
      ADD COLUMN IF NOT EXISTS end_time         VARCHAR(10),
      ADD COLUMN IF NOT EXISTS event_type       VARCHAR(100),
      ADD COLUMN IF NOT EXISTS phone            VARCHAR(15),
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hall_no_double_booking
      ON hall_bookings (event_date, slot)
      WHERE status NOT IN ('cancelled', 'rejected')
  `);
}
ensureSchema().catch(err =>
  console.error('hall-bookings: schema setup error:', err)
);

// ─────────────────────────────────────────────────────────
// GET /api/hall-bookings
// resident → own bookings only
// committee/admin → all bookings
// ?status=pending|confirmed|...   filter by status
// ?upcoming=true                  only future dates
// ─────────────────────────────────────────────────────────
router.get('/', requireLogin, async (req, res) => {
  try {
    const { status, upcoming } = req.query;
    const conditions = [];
    const params = [];

    if (req.user.role === 'resident') {
      if (!req.user.memberId) {
        return res.status(404).json({ error: 'No member record linked to this account.' });
      }
      params.push(req.user.memberId);
      conditions.push(`hb.member_id = $${params.length}`);
    }

    if (status && VALID_STATUSES.includes(status)) {
      params.push(status);
      conditions.push(`hb.status = $${params.length}`);
    }

    if (upcoming === 'true') {
      conditions.push(`hb.event_date >= CURRENT_DATE`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT hb.id, hb.booking_number, hb.event_name, hb.event_type,
              hb.event_date, hb.slot, hb.start_time, hb.end_time,
              hb.expected_guests, hb.phone, hb.special_requests,
              hb.status, hb.rejection_reason, hb.notes,
              hb.created_at, hb.updated_at,
              m.full_name AS member_name, m.house_number,
              u.display_name AS approved_by_name
       FROM hall_bookings hb
       JOIN members m ON m.id = hb.member_id
       LEFT JOIN users u ON u.id = hb.approved_by
       ${where}
       ORDER BY hb.event_date ASC, hb.created_at DESC`,
      params
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('GET /hall-bookings error:', err);
    return res.status(500).json({ error: 'Could not load bookings.' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/hall-bookings
// Any logged-in user. Resident books for themselves; committee/admin
// can pass houseNumber to book on behalf of a resident.
// Status starts as 'pending' — committee must approve to confirm.
// ─────────────────────────────────────────────────────────
router.post('/', requireLogin, async (req, res) => {
  try {
    const {
      eventName, eventType, eventDate,
      startTime, endTime, expectedGuests,
      phone, specialRequests, houseNumber,
    } = req.body;

    if (!eventName || !eventDate || !startTime || !endTime || !expectedGuests) {
      return res.status(400).json({
        error: 'Event name, date, start time, end time, and expected guest count are required.',
      });
    }

    const guestCount = parseInt(expectedGuests, 10);
    if (isNaN(guestCount) || guestCount < 1 || guestCount > 400) {
      return res.status(400).json({ error: 'Expected guests must be between 1 and 400.' });
    }

    // Minimum 48 hours notice
    const eventDt = new Date(eventDate);
    const diffHours = (eventDt - new Date()) / (1000 * 60 * 60);
    if (diffHours < 48) {
      return res.status(400).json({
        error: 'Bookings must be submitted at least 48 hours before the event date.',
      });
    }

    // Resolve member
    let memberId = req.user.memberId;
    if (req.user.role !== 'resident' && houseNumber) {
      const lookup = await pool.query(
        `SELECT id FROM members WHERE house_number = $1`, [houseNumber.trim()]
      );
      if (lookup.rows.length === 0) {
        return res.status(404).json({ error: `No member found with house number "${houseNumber}".` });
      }
      memberId = lookup.rows[0].id;
    }
    if (!memberId) {
      return res.status(400).json({ error: 'No member is associated with this booking.' });
    }

    const slot = deriveSlot(startTime);

    const result = await pool.query(
      `INSERT INTO hall_bookings
        (member_id, event_name, event_type, event_date, slot,
         start_time, end_time, expected_guests, phone,
         special_requests, status,
         base_fee, total_fee)   -- ← SET REAL PRICES HERE when ready
       VALUES ($1,$2,$3,$4,$5::hall_slot,$6,$7,$8,$9,$10,'pending',0,0)
       RETURNING id, booking_number`,
      [
        memberId, eventName, eventType || null, eventDate, slot,
        startTime, endTime, guestCount,
        phone || null, specialRequests || null,
      ]
    );

    return res.status(201).json({
      message: 'Booking request submitted. It will be reviewed by the committee.',
      id: result.rows[0].id,
      bookingNumber: result.rows[0].booking_number,
    });
  } catch (err) {
    console.error('POST /hall-bookings error:', err);
    return res.status(500).json({ error: 'Could not submit booking.' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/hall-bookings/:id/status
// Committee/admin only.
// Allowed transitions:
//   pending   → confirmed | rejected | cancelled
//   confirmed → completed | cancelled
// The DB partial unique index fires on 'confirmed' if the slot
// is already taken, returning a 409 with a clear message.
// ─────────────────────────────────────────────────────────
router.patch('/:id/status', requireLogin, requireRole('super_admin', 'committee'), async (req, res) => {
  try {
    const { id } = req.params;
    const { newStatus, rejectionReason, notes } = req.body;

    // Log incoming request so we can see it in Render logs
    console.log(`PATCH /hall-bookings/${id}/status — user role: ${req.user.role}, newStatus: ${newStatus}`);

    if (!newStatus || !VALID_STATUSES.includes(newStatus)) {
      return res.status(400).json({ error: 'Invalid or missing status.' });
    }
    if (newStatus === 'rejected' && !rejectionReason) {
      return res.status(400).json({ error: 'A rejection reason is required.' });
    }

    const current = await pool.query(
      `SELECT status FROM hall_bookings WHERE id = $1`, [id]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    console.log(`Current booking status: ${current.rows[0].status}`);

    const allowed = {
      pending:   ['confirmed', 'rejected', 'cancelled'],
      confirmed: ['completed', 'cancelled'],
      cancelled: [],
      rejected:  [],
      completed: [],
    };
    if (!allowed[current.rows[0].status]?.includes(newStatus)) {
      return res.status(400).json({
        error: `Cannot move a booking from "${current.rows[0].status}" to "${newStatus}".`,
      });
    }

    try {
      await pool.query(
        `UPDATE hall_bookings SET
           status           = $1::booking_status,
           rejection_reason = CASE WHEN $1 = 'rejected' THEN $2 ELSE rejection_reason END,
           notes            = COALESCE($3, notes),
           approved_by      = CASE WHEN $1 = 'confirmed' THEN $4 ELSE approved_by END,
           updated_at       = NOW()
         WHERE id = $5`,
        [newStatus, rejectionReason || null, notes || null, req.user.userId, id]
      );
    } catch (dbErr) {
      console.error('PATCH /hall-bookings/:id/status DB error:', dbErr.code, dbErr.message);
      if (dbErr.code === '23505') {
        return res.status(409).json({
          error: 'This date and time slot is already confirmed for another booking. The slot cannot be double-booked.',
        });
      }
      // Return the real DB error message so we can diagnose it
      return res.status(500).json({
        error: `Database error: ${dbErr.message}`,
      });
    }

    return res.json({ message: `Booking ${newStatus}.`, newStatus });
  } catch (err) {
    console.error('PATCH /hall-bookings/:id/status error:', err);
    return res.status(500).json({ error: `Could not update booking: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────
// DELETE /api/hall-bookings/:id
// Super admin only — for removing test/dummy rows.
// For real bookings use PATCH to cancel/reject instead.
// ─────────────────────────────────────────────────────────
router.delete('/:id', requireLogin, requireRole('super_admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM hall_bookings WHERE id = $1 RETURNING id`, [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }
    return res.json({ message: 'Booking deleted.' });
  } catch (err) {
    console.error('DELETE /hall-bookings/:id error:', err);
    return res.status(500).json({ error: 'Could not delete booking.' });
  }
});

module.exports = router;
