// Shared deployment-type key lookup for fail-loud parameter validation.
//
// Deployment-type keys are DATA-DEFINED (admin deployment-type templates), not
// an enum we can hardcode. Several backend surfaces are SILENT about unknown
// keys: an unknown deployment filter returns all-zero counts (issue #81, live
// 2026-07-21: deployment="prod" → confident "0 sessions" vs 713 real), and a
// pricing row gated on an unknown deployment type never matches any real
// deployment, so it silently drops from every quote (live 2026-07-21: the
// model wrote the pricing CATEGORY "core" into deployment_types on two items —
// backend validation accepted it, and the rows were unpriceable). Where the
// backend is silent, the tool layer must fail loud BEFORE the call/stage.
//
// Callers FAIL OPEN when this returns [] (lookup error/empty): validation must
// never turn a backend outage into a false rejection of a valid request.

import { scopelyFetch } from "./scopely-api.js";

// Fetch the valid deployment-type keys from the live template list.
// Returns [] on any failure so callers can fail open.
export async function fetchDeploymentTypeKeys(): Promise<string[]> {
  try {
    const templates = await scopelyFetch(`/api/admin/deployment-type-templates/`);
    if (!templates.ok) return [];
    const data = templates.data as { results?: unknown[] } | unknown[] | null;
    const rows = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
    return rows.map((row) => String((row as Record<string, unknown>)?.key ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}
