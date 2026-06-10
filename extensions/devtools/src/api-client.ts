// Read env at call time (not module load) so env that loads after import — and
// test stubbing — both resolve correctly. No baked-in base-URL fallback: pointing
// a missing-config deployment silently at the production devtools host (with
// whatever token happens to be set) is exactly the failure mode we refuse.
const DEVTOOLS_BASE = () => process.env.DEVTOOLS_API_URL ?? "";
const DEVTOOLS_TOKEN = () => process.env.DEV_TOOLS_API ?? "";

export async function devtoolsFetch(
  endpoint: string,
  options?: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const base = DEVTOOLS_BASE();
  const token = DEVTOOLS_TOKEN();
  if (!base) {
    return { ok: false, status: 0, data: { error: "DEVTOOLS_API_URL env var not set" } };
  }
  if (!token) {
    return { ok: false, status: 0, data: { error: "DEV_TOOLS_API env var not set" } };
  }

  const resp = await fetch(`${base}${endpoint}`, {
    ...options,
    headers: {
      ...options?.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  const data = resp.headers.get("content-type")?.includes("application/json")
    ? await resp.json()
    : await resp.text();

  return { ok: resp.ok, status: resp.status, data };
}
