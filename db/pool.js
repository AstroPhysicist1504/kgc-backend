// ─────────────────────────────────────────────────────────
// Single shared connection pool to the Supabase Postgres database.
// This connects as the "postgres" user (from your DATABASE_URL),
// which owns every table — so it bypasses Row Level Security (RLS)
// automatically. That's expected: RLS is a safety net for anyone
// who *doesn't* go through this backend, not a gate for this backend
// itself. All access-control decisions happen in our own route code.
// ─────────────────────────────────────────────────────────
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and fill in your Supabase connection string.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase requires SSL
  max: 10,
});

pool.on('error', (err) => {
  // Catches errors on idle clients so one bad connection doesn't crash the whole server
  console.error('Unexpected error on idle database client', err);
});

module.exports = pool;
