// POST /api/setup {secret} — idempotent: creates tables, seeds first admin if users table is empty.
import { getDb } from "./_shared/db.js";
import { hashPassword } from "./_shared/auth.js";
import { json, errorResponse, readJson } from "./_shared/http.js";

export async function onRequest(context) {
  const { request, env } = context;

  try {
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    const { secret } = await readJson(request);
    if (!env.SETUP_SECRET || secret !== env.SETUP_SECRET) {
      const e = new Error("Invalid setup secret."); e.status = 401; throw e;
    }

    const sql = getDb(env);

    await sql`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'executive',
      department TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )`;
    await sql`CREATE TABLE IF NOT EXISTS snapshots (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by INTEGER REFERENCES users(id),
      label TEXT,
      datasets JSONB NOT NULL,
      kpi JSONB NOT NULL,
      department_rollups JSONB NOT NULL DEFAULT '{}'::jsonb,
      overall_avg_score NUMERIC,
      is_current BOOLEAN NOT NULL DEFAULT false
    )`;
    await sql`CREATE TABLE IF NOT EXISTS workflow_items (
      id SERIAL PRIMARY KEY,
      item_type TEXT NOT NULL,
      item_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      assigned_to TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (item_type, item_key)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS workflow_comments (
      id SERIAL PRIMARY KEY,
      item_type TEXT NOT NULL,
      item_key TEXT NOT NULL,
      author_id INTEGER REFERENCES users(id),
      author_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

    const existing = await sql`SELECT count(*)::int AS n FROM users`;
    let seeded = false;
    if (existing[0].n === 0) {
      const name = env.ADMIN_NAME || "Admin";
      const email = (env.ADMIN_EMAIL || "").toLowerCase().trim();
      const password = env.ADMIN_PASSWORD || "";
      if (!email || !password) {
        const e = new Error("Tables created, but ADMIN_EMAIL and ADMIN_PASSWORD must be set as environment variables before the first admin can be seeded. Add them in the Cloudflare dashboard and call /api/setup again.");
        e.status = 400; throw e;
      }
      await sql`INSERT INTO users (name, email, password_hash, role) VALUES (${name}, ${email}, ${await hashPassword(password)}, 'admin')`;
      seeded = true;
    }

    return json({ ok: true, tablesReady: true, adminSeeded: seeded });
  } catch (err) {
    return errorResponse(err);
  }
}
