// /api/workflow                GET  -> all tracked items (status, assignee, comment count)
// /api/workflow/status         POST {itemType, itemKey, status, assignedTo} -> upsert
// /api/workflow/comment        POST {itemType, itemKey, body} -> add a comment
// /api/workflow/comments       GET  ?itemType=&itemKey= -> list comments for one item
import { sql } from "./_shared/db.js";
import { requireUser, requirePermission } from "./_shared/auth.js";
import { json, errorResponse, readJson, pathSegments } from "./_shared/http.js";

export const config = { path: ["/api/workflow", "/api/workflow/*"] };

const VALID_STATUSES = ["open", "in_progress", "resolved"];

export default async (req) => {
  try {
    const user = await requireUser(req);
    const segments = pathSegments(req);
    const sub = segments[2];
    const url = new URL(req.url);

    if (req.method === "GET" && !sub) {
      const rows = await sql`
        SELECT w.item_type, w.item_key, w.status, w.assigned_to, w.updated_at, u.name AS updated_by_name,
               (SELECT count(*) FROM workflow_comments c WHERE c.item_type = w.item_type AND c.item_key = w.item_key) AS comment_count
        FROM workflow_items w LEFT JOIN users u ON u.id = w.updated_by
      `;
      return json({ items: rows });
    }

    if (req.method === "GET" && sub === "comments") {
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

    if (req.method === "POST" && sub === "status") {
      requirePermission(user, "editWorkflow");
      const { itemType, itemKey, status, assignedTo } = await readJson(req);
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

    if (req.method === "POST" && sub === "comment") {
      requirePermission(user, "editWorkflow");
      const { itemType, itemKey, body } = await readJson(req);
      if (!itemType || !itemKey || !body || !body.trim()) { const e = new Error("itemType, itemKey, and body are required."); e.status = 400; throw e; }
      // Make sure a workflow_items row exists so the item shows up in the list even before a status change.
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
};
