// /api/auth/login           POST {email, password}
// /api/auth/logout          POST
// /api/auth/me              GET
// /api/auth/change-password POST {currentPassword, newPassword}
import { getDb } from "../_shared/db.js";
import { hashPassword, verifyPassword, createSession, destroySession, getCurrentUser, requireUser, parseCookie, sessionCookieHeader, clearSessionCookieHeader } from "../_shared/auth.js";
import { json, errorResponse, readJson, lastSegment } from "../_shared/http.js";

export async function onRequest(context) {
  const { request, env } = context;
  const sql = getDb(env);
  const action = lastSegment(request);

  try {
    if (action === "login" && request.method === "POST") {
      const { email, password } = await readJson(request);
      if (!email || !password) { const e = new Error("Email and password are required."); e.status = 400; throw e; }
      const rows = await sql`SELECT id, name, email, role, department, password_hash FROM users WHERE email = ${String(email).toLowerCase().trim()}`;
      const user = rows[0];
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        const e = new Error("Invalid email or password."); e.status = 401; throw e;
      }
      const token = await createSession(sql, user.id);
      return json(
        { user: { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department } },
        200,
        sessionCookieHeader(token)
      );
    }

    if (action === "logout" && request.method === "POST") {
      const token = parseCookie(request, "pai_session");
      await destroySession(sql, token);
      return json({ ok: true }, 200, clearSessionCookieHeader());
    }

    if (action === "me" && request.method === "GET") {
      const user = await getCurrentUser(sql, request);
      return json({ user: user || null });
    }

    if (action === "change-password" && request.method === "POST") {
      const user = await requireUser(sql, request);
      const { currentPassword, newPassword } = await readJson(request);
      if (!newPassword || String(newPassword).length < 8) { const e = new Error("New password must be at least 8 characters."); e.status = 400; throw e; }
      const rows = await sql`SELECT password_hash FROM users WHERE id = ${user.id}`;
      if (!rows[0] || !(await verifyPassword(currentPassword || "", rows[0].password_hash))) {
        const e = new Error("Current password is incorrect."); e.status = 401; throw e;
      }
      await sql`UPDATE users SET password_hash = ${await hashPassword(newPassword)} WHERE id = ${user.id}`;
      return json({ ok: true });
    }

    return json({ error: "Not found." }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}
