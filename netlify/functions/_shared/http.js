// Small consistent helpers for returning JSON and handling thrown errors.

export function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json" }
  });
}

export function errorResponse(err) {
  const status = err && err.status ? err.status : 500;
  if (status === 500) console.error(err);
  return json({ error: (err && err.message) || "Something went wrong." }, status);
}

export async function readJson(req) {
  try {
    return await req.json();
  } catch {
    const err = new Error("Expected a JSON request body.");
    err.status = 400;
    throw err;
  }
}

export function pathSegments(req) {
  return new URL(req.url).pathname.split("/").filter(Boolean);
}
