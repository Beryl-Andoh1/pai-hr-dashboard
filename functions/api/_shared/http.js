// JSON response helpers for Cloudflare Pages Functions.
// Cookies are set via Set-Cookie headers since there's no context.cookies API.

export function json(data, status, setCookieHeader) {
  const headers = new Headers({ "content-type": "application/json" });
  if (setCookieHeader) headers.set("set-cookie", setCookieHeader);
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

export function errorResponse(err) {
  const status = (err && err.status) ? err.status : 500;
  if (status === 500) console.error(err);
  return json({ error: (err && err.message) || "Something went wrong." }, status);
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    const err = new Error("Expected a JSON request body.");
    err.status = 400;
    throw err;
  }
}

export function lastSegment(request) {
  return new URL(request.url).pathname.split("/").filter(Boolean).pop();
}
