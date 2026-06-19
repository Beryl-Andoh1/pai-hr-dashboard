// /api/snapshots/current  GET  -> the live shared snapshot everyone sees (or null)
// /api/snapshots/history  GET  -> lightweight list of past snapshots, for the trend view
// /api/snapshots          POST -> push a new snapshot, becomes the new "current" one
import { sql } from "./_shared/db.js";
import { requireUser, requirePermission } from "./_shared/auth.js";
import { json, errorResponse, readJson, pathSegments } from "./_shared/http.js";

export const config = { path: ["/api/snapshots", "/api/snapshots/*"] };

export default async (req) => {
  try {
    const user = await requireUser(req);
    const segments = pathSegments(req); // ["api","snapshots"] or ["api","snapshots","current"|"history"]
    const sub = segments[2];

    if (req.method === "GET" && sub === "current") {
      const rows = await sql`
        SELECT s.id, s.created_at, s.label, s.datasets, s.kpi, s.department_rollups, s.overall_avg_score, u.name AS created_by_name
        FROM snapshots s LEFT JOIN users u ON u.id = s.created_by
        WHERE s.is_current = true
        ORDER BY s.created_at DESC LIMIT 1
      `;
      return json({ snapshot: rows[0] || null });
    }

    if (req.method === "GET" && sub === "history") {
      const rows = await sql`
        SELECT s.id, s.created_at, s.label, s.overall_avg_score, s.kpi, u.name AS created_by_name
        FROM snapshots s LEFT JOIN users u ON u.id = s.created_by
        ORDER BY s.created_at ASC
      `;
      return json({ snapshots: rows });
    }

    if (req.method === "POST" && !sub) {
      requirePermission(user, "pushSnapshot");
      const body = await readJson(req);
      const { datasets, kpi, departmentRollups, label, overallAvgScore } = body;
      if (!datasets || !kpi) { const e = new Error("Missing datasets or kpi in request body."); e.status = 400; throw e; }
      await sql`UPDATE snapshots SET is_current = false WHERE is_current = true`;
      const rows = await sql`
        INSERT INTO snapshots (created_by, label, datasets, kpi, department_rollups, overall_avg_score, is_current)
        VALUES (${user.id}, ${label || null}, ${JSON.stringify(datasets)}, ${JSON.stringify(kpi)}, ${JSON.stringify(departmentRollups || {})}, ${overallAvgScore ?? null}, true)
        RETURNING id, created_at, label
      `;
      return json({ snapshot: rows[0] }, 201);
    }

    return json({ error: "Not found." }, 404);
  } catch (err) {
    return errorResponse(err);
  }
};
