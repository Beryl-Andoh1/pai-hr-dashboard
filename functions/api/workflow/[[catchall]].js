// GET  /api/workflow             -> all tracked items with comment counts
// GET  /api/workflow/comments    -> comments for one item (?itemType=&itemKey=)
// POST /api/workflow/status      -> upsert status/assignee
// POST /api/workflow/comment     -> add a comment
import { getDb } from "../_shared/db.js";
import { requireUser, requirePermission } from "../_shared/auth.js";
import { json, errorResponse, readJson } from "../_shared/http.js";

const VALID_STATUSES = ["open", "in_progress", "resolved"];

export async function onRequest(context) {
  const { request, env } = context;
  const sql = getDb(env);
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const sub = segments[2]; // 'comments' | 'status' | 'comment' | undefined

  try {
    const user = await requireUser(sql, request);

    if (request.method === "GET" && !sub) {
      const rows = await sql`
        SELECT w.item_type, w.item_key, w.status, w.assigned_to, w.updated_at, u.name AS updated_by_name,
               (SELECT count(*) FROM workflow_comments c WHERE c.item_type = w.item_type AND c.item_key = w.item_key) AS comment_count
        FROM workflow_items w LEFT JOIN users u ON u.id = w.updated_by
      `;
      return json({ items: rows });
    }

    if (request.method === "GET" && sub === "comments") {
      const itemType = url.searchParams.get("itemType");
      const itemKey = url.searchParams.get("itemKey");
      if (!itemType || !itemKey) { const e = new Error("itemType and itemKey are required."); e.status = 400; throw e; }
      const rows = await sql`
        SELECT id, author_name, body, created_at FROM workflow_comments
        WHERE item_type = ${itemType} AND item_key = ${itemKey}
        ORDER BY created_at ASC
      `;
      return json({ comments: rows });
    }

    if (request.method === "POST" && sub === "status") {
      requirePermission(user, "editWorkflow");
      const { itemType, itemKey, status, assignedTo } = await readJson(request);
      if (!itemType || !itemKey) { const e = new Error("itemType and itemKey are required."); e.status = 400; throw e; }
      if (!VALID_STATUSES.includes(status)) { const e = new Error("Invalid status."); e.status = 400; throw e; }
      await sql`
        INSERT INTO workflow_items (item_type, item_key, status, assigned_to, updated_by, updated_at)
        VALUES (${itemType}, ${itemKey}, ${status}, ${assignedTo || null}, ${user.id}, now())
        ON CONFLICT (item_type, item_key) DO UPDATE
        SET status = EXCLUDED.status, assigned_to = EXCLUDED.assigned_to, updated_by = EXCLUDED.updated_by, updated_at = now()
      `;
      return json({ ok: true });
    }

    if (request.method === "POST" && sub === "comment") {
      requirePermission(user, "editWorkflow");
      const { itemType, itemKey, body } = await readJson(request);
      if (!itemType || !itemKey || !body || !body.trim()) { const e = new Error("itemType, itemKey, and body are required."); e.status = 400; throw e; }
      await sql`
        INSERT INTO workflow_items (item_type, item_key, status, updated_by, updated_at)
        VALUES (${itemType}, ${itemKey}, 'open', ${user.id}, now())
        ON CONFLICT (item_type, item_key) DO NOTHING
      `;
      const rows = await sql`
        INSERT INTO workflow_comments (item_type, item_key, author_id, author_name, body)
        VALUES (${itemType}, ${itemKey}, ${user.id}, ${user.name}, ${body.trim()})
        RETURNING id, author_name, body, created_at
      `;
      return json({ comment: rows[0] }, 201);
    }

    return json({ error: "Not found." }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}
