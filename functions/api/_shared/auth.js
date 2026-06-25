// Password hashing (PBKDF2 via Web Crypto — works in Cloudflare Workers),
// session management, cookie helpers, and role permission table.
// Note: unlike the Netlify version this uses async password functions because
// Web Crypto is Promise-based. All callers must await hashPassword/verifyPassword.

const SESSION_COOKIE = "pai_session";
const SESSION_DAYS = 7;
const PBKDF2_ITERATIONS = 100000;

/* ---------------------------------- passwords ---------------------------------- */

function hexFrom(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function bufferFrom(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
}

export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hashBuffer = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, 256);
  return hexFrom(salt.buffer) + ":" + hexFrom(hashBuffer);
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [saltHex, storedHex] = stored.split(":");
  if (!saltHex || !storedHex) return false;
  const salt = bufferFrom(saltHex);
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hashBuffer = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, 256);
  const computed = hexFrom(hashBuffer);
  // Constant-time compare
  if (computed.length !== storedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ storedHex.charCodeAt(i);
  return diff === 0;
}

/* ---------------------------------- tokens / cookies ---------------------------------- */

export function generateToken() {
  return hexFrom(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

export function parseCookie(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";").map((p) => p.trim())) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx) === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return null;
}

export function sessionCookieHeader(token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return SESSION_COOKIE + "=" + encodeURIComponent(token) + "; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge + "; Path=/";
}

export function clearSessionCookieHeader() {
  return SESSION_COOKIE + "=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/";
}

/* ---------------------------------- sessions (require sql instance) ---------------------------------- */

export async function createSession(sql, userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await sql`INSERT INTO sessions (token, user_id, expires_at) VALUES (${token}, ${userId}, ${expiresAt})`;
  return token;
}

export async function destroySession(sql, token) {
  if (!token) return;
  await sql`DELETE FROM sessions WHERE token = ${token}`;
}

export async function getCurrentUser(sql, request) {
  const token = parseCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const rows = await sql`
    SELECT u.id, u.name, u.email, u.role, u.department
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.expires_at > now()
  `;
  return rows[0] || null;
}

export async function requireUser(sql, request) {
  const user = await getCurrentUser(sql, request);
  if (!user) { const e = new Error("Not authenticated"); e.status = 401; throw e; }
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
