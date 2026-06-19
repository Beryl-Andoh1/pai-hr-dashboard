# Performance Alignment Intelligence

An internal multi-user dashboard for L'AINE HR that analyses whether employees' weekly tasks align with individual, departmental, and company goals.

**What it does:** Upload four HR datasets (Company Goals, Departmental Goals, Individual Employee Goals, Weekly KPI Planner) → the app validates them, classifies every weekly task against the goal hierarchy, and generates department/employee/organisational reports, an at-risk goal tracker with workflow follow-up, and a trend-over-time view across publishing sessions.

**How sharing works:** Users with publishing permission (Admin, HR Manager) run the analysis and publish a snapshot to the shared backend. Everyone who is logged in then sees the same live data — no per-person uploads needed.

---

## Folder structure

```
index.html                 the app shell
styles.css                 all styling
app.js                     all client-side logic (parsing, validation, scoring, reports, exports)
manifest.json              PWA manifest
sw.js                      service worker (offline shell caching)
icons/                     app icons (192px, 512px)
templates/                 sample / blank-format CSVs for the 4 required datasets
package.json               declares @netlify/neon dependency
netlify.toml               build config + security headers
netlify/functions/
  _shared/db.js            Postgres connection (Netlify DB / Neon)
  _shared/auth.js          password hashing, sessions, cookie helpers, role permissions
  _shared/http.js          JSON response helpers
  auth.js                  POST /api/auth/login|logout, GET /api/auth/me, POST /api/auth/change-password
  users.js                 GET|POST /api/users, DELETE /api/users/:id  (admin only)
  snapshots.js             GET /api/snapshots/current|history, POST /api/snapshots
  workflow.js              GET /api/workflow[/comments], POST /api/workflow/status|comment
  setup.js                 POST /api/setup  (one-time table creation + first-admin seed)
db/schema.sql              human-readable copy of the database schema (for reference/manual inspection)
```

---

## One-time backend setup (after first deploy to Netlify)

### Step 1 — Provision a database

1. Open your site in the Netlify dashboard.
2. Go to **Site configuration → Database**.
3. Click **Connect database** (or **Provision database**). Netlify will create a Neon Postgres instance and automatically set the `NETLIFY_DATABASE_URL` environment variable for you.
4. Claim your database within 7 days (follow the link in the dashboard) to connect it to your own Neon account for long-term retention.

### Step 2 — Set environment variables

Still in **Site configuration → Environment variables**, add these four:

| Variable | Value |
|---|---|
| `SETUP_SECRET` | A long random string you choose — used once to protect the setup endpoint |
| `ADMIN_NAME` | Display name for the first admin user, e.g. `Jane Doe` |
| `ADMIN_EMAIL` | Email address the admin will log in with |
| `ADMIN_PASSWORD` | Temporary password (min 8 characters) — change it after first login |

### Step 3 — Redeploy

Trigger a new deploy so the functions pick up the new environment variables.

### Step 4 — Create the database tables and first admin

Call the setup endpoint **once** after the deploy completes:

```bash
curl -X POST https://YOUR-SITE.netlify.app/api/setup \
  -H "Content-Type: application/json" \
  -d '{"secret":"YOUR_SETUP_SECRET"}'
```

You should get back:

```json
{ "ok": true, "tablesReady": true, "adminSeeded": true }
```

The setup endpoint is idempotent — safe to call again, but won't re-seed the admin once a user already exists.

### Step 5 — Log in and create accounts for the team

1. Open the app and sign in with the admin email and password you set.
2. Go to **Manage Users** in the sidebar.
3. Create named accounts for each member of the team. Share each person's temporary password through a separate secure channel (email, Slack DM, etc.).
4. Ask them to change their password on first use (tell them to use **Account → Change password** — or add that feature later).

---

## Roles

| Role | Can upload & publish data | Can mark workflow items / add comments | Can manage users |
|---|---|---|---|
| **Admin** | ✅ | ✅ | ✅ |
| **HR Manager** | ✅ | ✅ | — |
| **Head of Department** | — | ✅ | — |
| **Executive** | — | — | — |

The role controls both what appears in the sidebar and what the API will actually accept. The server re-checks permission on every write, so the client-side gating is defence-in-depth, not the security boundary.

---

## Running locally (front-end only)

The front-end still works without the backend — it will show the login screen, and since there's no real API to call it won't be able to log you in. To test the UI in isolation, serve the folder:

```bash
python3 -m http.server 8080
```

and visit `http://localhost:8080`.

---

## Important notes

- **This backend code was written and tested for syntax, but could not be executed against a live database in the build environment** (the sandbox has no outbound network access). Deploy it, call `/api/setup`, log in, and verify everything works end-to-end. If you hit any errors, the function logs are in the Netlify dashboard under **Functions → [function name] → Logs**.
- Email alerts were intentionally deferred. When you're ready, add a Resend (or similar) account, set `RESEND_API_KEY`, and extend `workflow.js` to send on status changes.
- Live AI-generated PPTX narrative is also available as a future add-on — just requires setting `ANTHROPIC_API_KEY` as an environment variable and a small swap in the export function.
