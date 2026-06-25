// Creates a Neon SQL client from the Cloudflare env object.
// Called once per request — pass context.env from your function handler.
import { neon } from "@neondatabase/serverless";

export function getDb(env) {
  return neon(env.DATABASE_URL);
}
