import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { GatewayMethodClient } from "./types.js";

const GATEWAY_PROTOCOL_VERSION = 3;
const CONNECT_SCOPES = ["operator.admin"];
const CHALLENGE_WAIT_MS = 500;
const DEFAULT_DEVICE_IDENTITY_PATH = path.join(os.homedir(), ".openclaw", "identity", "device.json");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

type StoredDeviceIdentity = {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
};

type GatewayEventFrame = {
  type: "event";
  event?: string;
  payload?: unknown;
};

function isResponseFrame(value: unknown): value is GatewayResponseFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const frame = value as Partial<GatewayResponseFrame>;
  return frame.type === "res" && typeof frame.id === "string" && typeof frame.ok === "boolean";
}

function isEventFrame(value: unknown): value is GatewayEventFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const frame = value as Partial<GatewayEventFrame>;
  return frame.type === "event";
}

function base64UrlEncode(input: Buffer): string {
  return input.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  const rawLength = ED25519_SPKI_PREFIX.length + 32;
  const matchesPrefix =
    spki.length === rawLength && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX);
  return matchesPrefix ? spki.subarray(ED25519_SPKI_PREFIX.length) : spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
}

function createDeviceIdentity(): DeviceIdentity {
  const keys = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };
}

function persistDeviceIdentity(filePath: string, identity: DeviceIdentity): void {
  const stored: StoredDeviceIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort hardening for existing files.
  }
}

function loadOrCreateDeviceIdentity(filePath = DEFAULT_DEVICE_IDENTITY_PATH): DeviceIdentity {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as StoredDeviceIdentity;
      if (
        parsed.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKeyPem === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {
        const derivedDeviceId = fingerprintPublicKey(parsed.publicKeyPem);
        if (derivedDeviceId !== parsed.deviceId) {
          const corrected = {
            ...parsed,
            deviceId: derivedDeviceId,
          };
          fs.writeFileSync(filePath, `${JSON.stringify(corrected, null, 2)}\n`, { mode: 0o600 });
          try {
            fs.chmodSync(filePath, 0o600);
          } catch {
            // Best-effort hardening for existing files.
          }
          return {
            deviceId: derivedDeviceId,
            publicKeyPem: parsed.publicKeyPem,
            privateKeyPem: parsed.privateKeyPem,
          };
        }
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch {
    // Fall through to identity regeneration.
  }

  const identity = createDeviceIdentity();
  try {
    persistDeviceIdentity(filePath, identity);
  } catch {
    // Continue with ephemeral identity if disk persistence is unavailable.
  }
  return identity;
}

function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string;
  nonce?: string;
}): string {
  const withNonce = typeof params.nonce === "string" && params.nonce.length > 0;
  const version = withNonce ? "v2" : "v1";
  const base = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
  ];
  if (withNonce) {
    base.push(params.nonce as string);
  }
  return base.join("|");
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(signature);
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

export class GatewayRpcClient implements GatewayMethodClient {
  private readonly identity: DeviceIdentity;

  constructor(
    private readonly options: {
      url: string;
      token?: string;
      password?: string;
      timeoutMs?: number;
      deviceIdentityPath?: string;
    },
  ) {
    this.identity = loadOrCreateDeviceIdentity(options.deviceIdentityPath);
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const url = this.options.url.trim();
    const token = this.options.token?.trim();
    const password = this.options.password?.trim();
    const ws = new WebSocket(url);
    const connectId = randomUUID();
    const requestId = randomUUID();

    return await new Promise<T>((resolve, reject) => {
      let connected = false;
      let settled = false;
      let connectSent = false;
      let challengeTimer: NodeJS.Timeout | null = null;

      const finish = (value?: T, error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (challengeTimer) {
          clearTimeout(challengeTimer);
          challengeTimer = null;
        }
        ws.removeAllListeners();
        try {
          ws.close();
        } catch {
          // ignore shutdown failures
        }
        if (error) {
          reject(error);
          return;
        }
        resolve(value as T);
      };

      const timer = setTimeout(() => {
        finish(undefined, new Error(`gateway timeout (${timeoutMs}ms) for method ${method}`));
      }, timeoutMs);

      const sendConnect = (nonce?: string) => {
        if (connectSent) {
          return;
        }
        connectSent = true;

        const signedAtMs = Date.now();
        const payload = buildDeviceAuthPayload({
          deviceId: this.identity.deviceId,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          scopes: CONNECT_SCOPES,
          signedAtMs,
          ...(token ? { token } : {}),
          ...(nonce ? { nonce } : {}),
        });
        const signature = signDevicePayload(this.identity.privateKeyPem, payload);
        const connectParams = {
          minProtocol: GATEWAY_PROTOCOL_VERSION,
          maxProtocol: GATEWAY_PROTOCOL_VERSION,
          client: {
            id: "cli",
            version: "0.1.0",
            platform: `node-${process.platform}`,
            mode: "cli",
            instanceId: randomUUID(),
          },
          role: "operator",
          scopes: CONNECT_SCOPES,
          caps: [],
          auth:
            token || password
              ? {
                  ...(token ? { token } : {}),
                  ...(password ? { password } : {}),
                }
              : undefined,
          device: {
            id: this.identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(this.identity.publicKeyPem),
            signature,
            signedAt: signedAtMs,
            ...(nonce ? { nonce } : {}),
          },
          userAgent: "slm-dashboard-bff",
          locale: "en-US",
        };
        ws.send(
          JSON.stringify({
            type: "req",
            id: connectId,
            method: "connect",
            params: connectParams,
          }),
        );
      };

      ws.on("open", () => {
        challengeTimer = setTimeout(() => {
          sendConnect();
        }, CHALLENGE_WAIT_MS);
      });

      ws.on("message", (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }

        if (isEventFrame(parsed)) {
          const nonce =
            parsed.event === "connect.challenge" &&
            parsed.payload &&
            typeof parsed.payload === "object" &&
            !Array.isArray(parsed.payload) &&
            typeof (parsed.payload as { nonce?: unknown }).nonce === "string"
              ? ((parsed.payload as { nonce: string }).nonce ?? "").trim()
              : "";
          if (nonce) {
            if (challengeTimer) {
              clearTimeout(challengeTimer);
              challengeTimer = null;
            }
            sendConnect(nonce);
          }
          return;
        }

        if (!isResponseFrame(parsed)) {
          return;
        }

        if (parsed.id === connectId) {
          if (!parsed.ok) {
            finish(undefined, new Error(parsed.error?.message || "gateway connect failed"));
            return;
          }
          connected = true;
          ws.send(
            JSON.stringify({
              type: "req",
              id: requestId,
              method,
              params,
            }),
          );
          return;
        }

        if (!connected || parsed.id !== requestId) {
          return;
        }

        if (!parsed.ok) {
          finish(undefined, new Error(parsed.error?.message || `gateway method failed: ${method}`));
          return;
        }
        finish(parsed.payload as T);
      });

      ws.on("error", (error) => {
        finish(undefined, error instanceof Error ? error : new Error(String(error)));
      });

      ws.on("close", (code, reason) => {
        if (!settled) {
          const detail = reason.toString() || "no close reason";
          finish(undefined, new Error(`gateway closed (${code}): ${detail}`));
        }
      });
    });
  }
}
