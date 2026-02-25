type ZoomDmResult = {
  ok: boolean;
  error?: string;
};

let cachedToken: { token: string; expiresAt: number } | null = null;

function hasValue(value: string | undefined): value is string {
  return Boolean(value && value.trim());
}

async function getZoomReportToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const clientId = process.env.ZOOM_REPORT_CLIENT_ID?.trim();
  const clientSecret = process.env.ZOOM_REPORT_CLIENT_SECRET?.trim();
  const accountId = process.env.ZOOM_REPORT_ACCOUNT_ID?.trim() || process.env.ZOOM_ACCOUNT_ID?.trim();
  if (!hasValue(clientId) || !hasValue(clientSecret) || !hasValue(accountId)) {
    throw new Error(
      "Zoom report credentials missing. Set ZOOM_REPORT_CLIENT_ID/ZOOM_REPORT_CLIENT_SECRET/ZOOM_REPORT_ACCOUNT_ID.",
    );
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${basic}` },
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zoom token request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token || !data.expires_in) {
    throw new Error("Zoom token response missing access_token/expires_in.");
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}

export async function sendStakeholderZoomDm(params: {
  toContact: string;
  message: string;
  fromUser?: string;
}): Promise<ZoomDmResult> {
  const toContact = params.toContact.trim();
  if (!toContact) return { ok: false, error: "missing toContact" };

  const fromUser =
    params.fromUser?.trim() ||
    process.env.ZOOM_REPORT_USER?.trim() ||
    process.env.MENTION_PROXY?.trim();
  if (!fromUser) {
    return {
      ok: false,
      error: "missing from user (set ZOOM_REPORT_USER or MENTION_PROXY)",
    };
  }

  try {
    const token = await getZoomReportToken();
    const response = await fetch(
      `https://api.zoom.us/v2/chat/users/${encodeURIComponent(fromUser)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to_contact: toContact,
          message: params.message,
        }),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        error: `zoom dm failed (${response.status}): ${body.slice(0, 300)}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

