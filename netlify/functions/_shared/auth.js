// Password hashing, session helpers, and role permissions shared by every
// function that needs to know who's calling and what they're allowed to do.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { sql } from "./db.js";

const SESSION_COOKIE = "pai_session";
const SESSION_DAYS = 7;

/* ---------------------------------- passwords ---------------------------------- */

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return salt + ":" + hash;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const hashBuffer = Buffer.from(hash, "hex");
  const candidateBuffer = scryptSync(password, salt, 64);
  if (hashBuffer.length !== candidateBuffer.length) return false;
  return timingSafeEqual(hashBuffer, candidateBuffer);
}

/* ---------------------------------- cookies ---------------------------------- */

export function parseCookie(req, name) {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const parts = header.split(";").map((p) => p.trim());
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx) === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return null;
}

export function setSessionCookie(context, token) {
  context.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: SESSION_DAYS * 24 * 60 * 60
  });
}

export function clearSessionCookie(context) {
  context.cookies.delete({ name: SESSION_COOKIE, path: "/" });
}

/* ---------------------------------- sessions ---------------------------------- */

export async function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await sql`
    INSERT INTO sessions (token, user_id, expires_at)
    VALUES (${token}, ${userId}, ${expiresAt})
  `;
  return token;
}

export async function destroySession(token) {
  if (!token) return;
  await sql`DELETE FROM sessions WHERE token = ${token}`;
}

// Returns the logged-in user (without password_hash) for a request, or null.
export async function getCurrentUser(req) {
  const token = parseCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const rows = await sql`
    SELECT u.id, u.name, u.email, u.role, u.department
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.expires_at > now()
  `;
  return rows[0] || null;
}

export async function requireUser(req) {
  const user = await getCurrentUser(req);
  if (!user) {
    const err = new Error("Not authenticated");
    err.status = 401;
    throw err;
  }
  return user;
}

/* ---------------------------------- permissions ---------------------------------- */

export const ROLE_PERMISSIONS = {
  admin: { manageUsers: true, pushSnapshot: true, editWorkflow: true },
  hr_manager: { manageUsers: false, pushSnapshot: true, editWorkflow: true },
  head_of_dept: { manageUsers: false, pushSnapshot: false, editWorkflow: true },
  executive: { manageUsers: false, pushSnapshot: false, editWorkflow: false }
};

export function can(user, permission) {
  const perms = ROLE_PERMISSIONS[user.role];
  return !!(perms && perms[permission]);
}

export function requirePermission(user, permission) {
  if (!can(user, permission)) {
    const err = new Error("You don't have permission to do that.");
    err.status = 403;
    throw err;
  }
}
