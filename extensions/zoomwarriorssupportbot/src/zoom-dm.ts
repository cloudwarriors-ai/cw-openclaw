// Zoom DM sender for stakeholder notifications

let cachedReportToken: { token: string; expiresAt: number } | null = null;

async function getReportToken(): Promise<string> {
  if (cachedReportToken && Date.now() < cachedReportToken.expiresAt - 60_000) {
    return cachedReportToken.token;
  }
  const clientId = process.env.ZOOM_REPORT_CLIENT_ID ?? "";
  const clientSecret = process.env.ZOOM_REPORT_CLIENT_SECRET ?? "";
  const accountId = process.env.ZOOM_REPORT_ACCOUNT_ID ?? process.env.ZOOM_ACCOUNT_ID ?? "";
  if (!clientId || !clientSecret || !accountId) {
    throw new Error("ZOOM_REPORT_CLIENT_ID/SECRET/ACCOUNT_ID not set");
  }
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const resp = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
    { method: "POST", headers: { Authorization: `Basic ${auth}` } },
  );
  if (!resp.ok) throw new Error(`Zoom report token failed: ${resp.status}`);
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedReportToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedReportToken.token;
}

export async function sendStakeholderZoomDm(opts: {
  toContact: string;
  message: string;
}): Promise<{ ok: boolean; error?: string }> {
  const fromUser = process.env.ZOOM_REPORT_USER ?? process.env.MENTION_PROXY ?? "";
  if (!fromUser) return { ok: false, error: "ZOOM_REPORT_USER not set" };

  try {
    const token = await getReportToken();
    const resp = await fetch(
      `https://api.zoom.us/v2/chat/users/${encodeURIComponent(fromUser)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: opts.message,
          to_contact: opts.toContact,
        }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `HTTP ${resp.status}: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
