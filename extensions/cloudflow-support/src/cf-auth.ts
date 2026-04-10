/**
 * Firebase Auth for CloudFlow Operations API.
 *
 * Uses Firebase Admin SDK to mint a custom token for the bot user,
 * then exchanges it for an ID token via the Firebase Auth REST API.
 *
 * Required env vars:
 *   CF_FIREBASE_API_KEY        — Firebase Web API key (for token exchange)
 *   CF_FIREBASE_PROJECT_ID     — Firebase project ID (default: cloudflow-a78f0)
 *   CF_FIREBASE_CLIENT_EMAIL   — Service account email
 *   CF_FIREBASE_PRIVATE_KEY    — Service account private key (PEM, with \n)
 *   CF_BOT_USER_UID            — UID of the bot user in Firestore users collection
 *   CF_API_BASE_URL            — CloudFlow API base URL (default: https://cloudflow.cx)
 */

let cachedIdToken: { token: string; expiresAt: number } | null = null;

function getEnv(key: string, fallback?: string): string {
  const value = process.env[key]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${key}`);
}

/**
 * Create a custom token using Firebase Admin SDK approach (JWT signing).
 * We sign a JWT with the service account credentials that Firebase Auth accepts.
 */
async function createCustomToken(uid: string): Promise<string> {
  const clientEmail = getEnv("CF_FIREBASE_CLIENT_EMAIL");
  const privateKeyRaw = getEnv("CF_FIREBASE_PRIVATE_KEY");
  // Handle escaped newlines from env vars
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: now,
    exp: now + 3600,
    uid,
  };

  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${enc(header)}.${enc(payload)}`;

  const crypto = await import("crypto");
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(unsigned);
  const signature = sign.sign(privateKey, "base64url");

  return `${unsigned}.${signature}`;
}

/**
 * Exchange a custom token for a Firebase ID token via the REST API.
 */
async function exchangeCustomTokenForIdToken(customToken: string): Promise<{ idToken: string; expiresIn: number }> {
  const apiKey = getEnv("CF_FIREBASE_API_KEY");
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Firebase token exchange failed (${resp.status}): ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { idToken?: string; expiresIn?: string };
  if (!data.idToken) throw new Error("Firebase token exchange returned no idToken");

  return {
    idToken: data.idToken,
    expiresIn: parseInt(data.expiresIn ?? "3600", 10),
  };
}

/**
 * Get a valid Firebase ID token for the bot user, with caching.
 */
export async function getFirebaseIdToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedIdToken && Date.now() < cachedIdToken.expiresAt - 60_000) {
    return cachedIdToken.token;
  }

  const uid = getEnv("CF_BOT_USER_UID");
  const customToken = await createCustomToken(uid);
  const { idToken, expiresIn } = await exchangeCustomTokenForIdToken(customToken);

  cachedIdToken = {
    token: idToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return cachedIdToken.token;
}

/**
 * Get the CloudFlow API base URL.
 */
/**
 * Clear the cached Firebase token (used for 401 retry).
 */
export function clearFirebaseToken(): void {
  cachedIdToken = null;
}

/**
 * Get the CloudFlow API base URL.
 */
export function getApiBaseUrl(): string {
  return getEnv("CF_API_BASE_URL", "https://cloudflow.cx");
}
