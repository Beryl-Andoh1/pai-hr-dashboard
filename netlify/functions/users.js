// /api/users        GET  -> list users (admin only)
//                   POST -> create a user {name, email, password, role, department?} (admin only)
// /api/users/:id     DELETE -> remove a user (admin only, can't delete yourself)
import { sql } from "./_shared/db.js";
import { requireUser, requirePermission, hashPassword } from "./_shared/auth.js";
import { json, errorResponse, readJson, pathSegments } from "./_shared/http.js";

export const config = { path: ["/api/users", "/api/users/*"] };

const VALID_ROLES = ["admin", "hr_manager", "head_of_dept", "executive"];

export default async (req) => {
  try {
    const user = await requireUser(req);
    requirePermission(user, "manageUsers");
    const segments = pathSegments(req); // ["api", "users"] or ["api", "users", "5"]
    const id = segments.length > 2 ? Number(segments[2]) : null;

    if (req.method === "GET" && !id) {
      const rows = await sql`SELECT id, name, email, role, department, created_at FROM users ORDER BY created_at ASC`;
      return json({ users: rows });
    }

    if (req.method === "POST" && !id) {
      const body = await readJson(req);
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
        VALUES (${name}, ${email}, ${hashPassword(password)}, ${role}, ${department})
        RETURNING id, name, email, role, department, created_at
      `;
      return json({ user: rows[0] }, 201);
    }

    if (req.method === "DELETE" && id) {
      if (id === user.id) { const e = new Error("You can't delete your own account."); e.status = 400; throw e; }
      await sql`DELETE FROM sessions WHERE user_id = ${id}`;
      await sql`DELETE FROM users WHERE id = ${id}`;
      return json({ ok: true });
    }

    return json({ error: "Not found." }, 404);
  } catch (err) {
    return errorResponse(err);
  }
};
