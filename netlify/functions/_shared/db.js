// Shared Postgres connection (Netlify DB, powered by Neon).
// `neon()` with no arguments reads the NETLIFY_DATABASE_URL environment
// variable automatically once you provision a database from the Netlify
// dashboard (Site configuration -> Database). It's safe to create this once
// at module scope and reuse it across warm function invocations: the Neon
// serverless driver talks HTTP per-query rather than holding a TCP socket
// open, so there's no connection-pool lifecycle to manage here.
import { neon } from "@netlify/neon";

export const sql = neon();
