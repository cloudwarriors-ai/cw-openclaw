import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const HASH_PREFIX = "scrypt";

type ParsedHash = {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  digest: Buffer;
};

function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.trim().split("$");
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) {
    return null;
  }
  const n = Number.parseInt(parts[1] ?? "", 10);
  const r = Number.parseInt(parts[2] ?? "", 10);
  const p = Number.parseInt(parts[3] ?? "", 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return null;
  }
  try {
    const salt = Buffer.from(parts[4] ?? "", "base64");
    const digest = Buffer.from(parts[5] ?? "", "base64");
    if (salt.length === 0 || digest.length === 0) {
      return null;
    }
    return { n, r, p, salt, digest };
  } catch {
    return null;
  }
}

export function verifyPasswordHash(password: string, encodedHash: string): boolean {
  const parsed = parseHash(encodedHash);
  if (!parsed) {
    return false;
  }
  try {
    const computed = scryptSync(password, parsed.salt, parsed.digest.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
    });
    if (computed.length !== parsed.digest.length) {
      return false;
    }
    return timingSafeEqual(computed, parsed.digest);
  } catch {
    return false;
  }
}

export function createPasswordHash(password: string): string {
  const salt = randomBytes(16);
  const n = 16_384;
  const r = 8;
  const p = 1;
  const digest = scryptSync(password, salt, 64, { N: n, r, p });
  return [HASH_PREFIX, String(n), String(r), String(p), salt.toString("base64"), digest.toString("base64")].join(
    "$",
  );
}
