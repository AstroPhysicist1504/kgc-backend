# KGC Backend — the "clerk" between your frontend and Supabase

This is a small Node.js server that sits between your website (the HTML
file) and your Supabase database. Your frontend will never talk to
Supabase directly — it talks to this backend, and this backend talks to
Supabase using the database's master credentials, which stay private on
the server and are never sent to anyone's browser.

## What's included

```
backend/
  server.js           → starts the server, wires up routes
  db/pool.js           → the one shared database connection
  middleware/auth.js   → checks "who is logged in?" and "are they allowed to do this?"
  routes/auth.js       → login, /me (session restore), change-password, admin reset-password
  routes/members.js    → CRUD for the `members` table (the template to copy)
  routes/complaints.js → full complaint lifecycle (raise, view, update status, rate)
  .env.example         → copy to .env and fill in your real values
  package.json
```

This was tested end-to-end on a local Postgres database with the same
schema as your Supabase project — login, password changes, admin resets,
the full complaint lifecycle, and permission checks between a resident
and an admin were all verified working.

**Tables with real backend routes so far:** `users` (auth), `members`,
`complaints` + `complaint_updates`. The other 13 tables (bills, notices,
hall bookings, gym memberships, etc.) follow the exact same pattern as
`members.js` / `complaints.js` — see "Adding more routes" below.

## 1. Local setup

```bash
cd backend
npm install
cp .env.example .env
```

Open `.env` and fill in:
- `DATABASE_URL` — from Supabase: **Project Settings → Database → Connection string → URI**. Use your real database password (the one you set when creating the Supabase project).
- `JWT_SECRET` — any long random string. Generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `ALLOWED_ORIGINS` — the URL(s) your frontend will be served from.

Then run:
```bash
npm start
```

You should see `KGC backend running on port 4000`.

## 2. Test it's working

```bash
curl http://localhost:4000/api/health
# {"status":"ok"}

curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"identifier":"admin@krishnagrand.in","password":"Admin@1234"}'
# Returns a token — CHANGE THIS PASSWORD in Supabase after first real login.
```

## 3. How your frontend connects to this

Your current HTML file logs in using a hardcoded JavaScript array
(`ACCOUNTS`). That needs to become a real network call instead. Example
of what the new login function should look like:

```javascript
async function doLogin() {
  const identifier = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value.trim();

  const res = await fetch('https://your-backend-url.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });

  if (!res.ok) {
    document.getElementById('login-error').classList.remove('hidden');
    return;
  }

  const data = await res.json();
  // Store the token so future requests can include it.
  // (Do NOT store the password anywhere.)
  sessionStorage.setItem('kgc_token', data.token);
  currentUser = data.user; // { role, displayName, email, houseNumber }
  showApp(); // your existing function that switches from login screen to dashboard
}
```

Then every subsequent data request includes that token:

```javascript
async function fetchMembers() {
  const token = sessionStorage.getItem('kgc_token');
  const res = await fetch('https://your-backend-url.com/api/members', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}
```

**Note on `sessionStorage`:** this clears when the browser tab closes,
which is a reasonable default for a society admin portal. If you want
"stay logged in" across browser restarts, `localStorage` behaves the
same way but persists longer — either is fine here since the token
itself expires server-side after `JWT_EXPIRES_IN` (12h by default).

## 4. Adding more routes (complaints, bills, notices, etc.)

Copy `routes/members.js` as your template for each remaining table. The
pattern for every route is:

1. `requireLogin` — must be logged in at all.
2. Inside the handler, check `req.user.role` and `req.user.memberId` to
   decide what to return or allow — never trust anything the frontend
   claims about the user.
3. Use `requireRole('super_admin', 'committee')` on routes only staff
   should be able to call (e.g. approving a bill, posting a notice).

Then register the new route file in `server.js`:
```javascript
app.use('/api/complaints', require('./routes/complaints'));
```

## 5. Deploying (making this live on the internet)

Free options that work well for this:
- **Render** (render.com) — connect your GitHub repo, set the same
  environment variables from `.env`, done.
- **Railway** (railway.app) — similar, also has a generous free tier.

Whichever you pick: set `DATABASE_URL`, `JWT_SECRET`, and
`ALLOWED_ORIGINS` (pointing at wherever your frontend ends up being
hosted) as environment variables in that platform's dashboard — never
commit the real `.env` file to GitHub. A `.gitignore` with `.env` in it
is included implicitly by not committing it; add a `.gitignore` file
with `.env` and `node_modules/` before pushing to GitHub.

## Important: fix your live Supabase admin password

While building this, I found that the default admin password hash in
your `schema.sql` was not a genuine bcrypt hash — it would never have
worked for login. I've corrected it in your updated `schema.sql`. If
you already ran the old version on Supabase, run this once in the
Supabase SQL Editor to fix the live row (login will still be
`admin@krishnagrand.in` / `Admin@1234` — change it immediately after
your first real login):

```sql
UPDATE users
SET password_hash = '$2b$10$NS/orlyM0dDYmHbPMOz0ou5/5c1IMmlU5HMbQHGowDzyIWyBqOHTu'
WHERE email = 'admin@krishnagrand.in';
```
