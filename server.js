require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const memberRoutes = require('./routes/members');

const app = express();

// Only allow requests from your own frontend's domain(s) — set in .env
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    // Allow tools like curl/Postman (no origin header) and any whitelisted origin
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
}));

app.use(express.json());

// Health check — useful for confirming the server is alive after deploy
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/members', memberRoutes);

// TODO: as you extend the app, add more route files here following the
// same pattern as routes/members.js — e.g.:
//   app.use('/api/complaints', require('./routes/complaints'));
//   app.use('/api/bills', require('./routes/bills'));
//   app.use('/api/notices', require('./routes/notices'));

// Catch-all error handler — never leak raw error details to the client
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`KGC backend running on port ${PORT}`);
});
