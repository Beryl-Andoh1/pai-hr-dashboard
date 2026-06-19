// /api/auth/login   POST {email, password} -> sets session cookie, returns user
// /api/auth/logout  POST -> clears session
// /api/auth/me      GET  -> returns current user, or 401
// /api/auth/change-password  POST {currentPassword, newPassword}
import { sql } from "./_shared/db.js";
import {
  hashPassword, verifyPassword, createSession, destroySession,
  setSessionCookie, clearSessionCookie, parseCookie, getCurrentUser, requireUser
} from "./_shared/auth.js";
import { json, errorResponse, readJson } from "./_shared/http.js";

export const config = { path: "/api/auth/*" };

export default async (req, context) => {
  const action = new URL(req.url).pathname.split("/").pop();

  try {
    if (action === "login" && req.method === "POST") {
      const { email, password } = await readJson(req);
      if (!email || !password) { const e = new Error("Email and password are required."); e.status = 400; throw e; }
      const rows = await sql`SELECT id, name, email, role, department, password_hash FROM users WHERE email = ${String(email).toLowerCase().trim()}`;
      const user = rows[0];
      if (!user || !verifyPassword(password, user.password_hash)) {
        const e = new Error("Invalid email or password."); e.status = 401; throw e;
      }
      const token = await createSession(user.id);
      setSessionCookie(context, token);
      return json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department } });
    }

    if (action === "logout" && req.method === "POST") {
      const token = parseCookie(req, "pai_session");
      await destroySession(token);
      clearSessionCookie(context);
      return json({ ok: true });
    }

    if (action === "me" && req.method === "GET") {
      const user = await getCurrentUser(req);
      if (!user) return json({ user: null }, 200);
      return json({ user });
    }

    if (action === "change-password" && req.method === "POST") {
      const user = await requireUser(req);
      const { currentPassword, newPassword } = await readJson(req);
      if (!newPassword || String(newPassword).length < 8) { const e = new Error("New password must be at least 8 characters."); e.status = 400; throw e; }
      const rows = await sql`SELECT password_hash FROM users WHERE id = ${user.id}`;
      if (!rows[0] || !verifyPassword(currentPassword || "", rows[0].password_hash)) {
        const e = new Error("Current password is incorrect."); e.status = 401; throw e;
      }
      await sql`UPDATE users SET password_hash = ${hashPassword(newPassword)} WHERE id = ${user.id}`;
      return json({ ok: true });
    }

    return json({ error: "Not found." }, 404);
  } catch (err) {
    return errorResponse(err);
  }
};
