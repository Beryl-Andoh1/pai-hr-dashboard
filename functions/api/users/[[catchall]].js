// GET  /api/users        -> list users (admin only)
// POST /api/users        -> create user (admin only)
// DELETE /api/users/:id  -> remove user (admin only)
import { getDb } from "../_shared/db.js";
import { hashPassword, requireUser, requirePermission } from "../_shared/auth.js";
import { json, errorResponse, readJson } from "../_shared/http.js";

const VALID_ROLES = ["admin", "hr_manager", "head_of_dept", "executive"];

export async function onRequest(context) {
  const { request, env, params } = context;
  const sql = getDb(env);

  try {
    const user = await requireUser(sql, request);
    requirePermission(user, "manageUsers");

    // Extract optional :id from the URL path
    const segments = new URL(request.url).pathname.split("/").filter(Boolean);
    const id = segments.length > 2 ? Number(segments[segments.length - 1]) : null;

    if (request.method === "GET" && !id) {
      const rows = await sql`SELECT id, name, email, role, department, created_at FROM users ORDER BY created_at ASC`;
      return json({ users: rows });
    }

    if (request.method === "POST" && !id) {
      const body = await readJson(request);
      const name = (body.name || "").trim();
      const email = (body.email || "").trim().toLowerCase();
      const password = body.password || "";
      const role = body.role || "executive";
      const department = body.department ? String(body.department).trim() : null;
      if (!name || !email || !password) { const e = new Error("Name, email, and password are required."); e.status = 400; throw e; }
      if (password.length < 8) { const e = new Error("Password must be at least 8 characters."); e.status = 400; throw e; }
      if (!VALID_ROLES.includes(role)) { const e = new Error("Invalid role."); e.status = 400; throw e; }
      const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
      if (existing[0]) { const e = new Error("A user with that email already exists."); e.status = 409; throw e; }
      const rows = await sql`
        INSERT INTO users (name, email, password_hash, role, department)
        VALUES (${name}, ${email}, ${await hashPassword(password)}, ${role}, ${department})
        RETURNING id, name, email, role, department, created_at
      `;
      return json({ user: rows[0] }, 201);
    }

    if (request.method === "DELETE" && id) {
      if (id === user.id) { const e = new Error("You can't delete your own account."); e.status = 400; throw e; }
      await sql`DELETE FROM sessions WHERE user_id = ${id}`;
      await sql`DELETE FROM users WHERE id = ${id}`;
      return json({ ok: true });
    }

    return json({ error: "Not found." }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}
