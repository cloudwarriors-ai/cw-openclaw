import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redirect the uploads dir (derived from os.homedir at module load) into a temp
// dir so these tests never touch the real ~/.openclaw tree.
const TEST_HOME = vi.hoisted(() => {
  const fsh = require("node:fs") as typeof import("node:fs");
  const osh = require("node:os") as typeof import("node:os");
  const pathh = require("node:path") as typeof import("node:path");
  return fsh.mkdtempSync(pathh.join(osh.tmpdir(), "zoom-upload-guards-"));
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => TEST_HOME }, homedir: () => TEST_HOME };
});

// The upload handler routes the processed upload to the agent — mock the heavy
// monitor-handler/channel-memory modules; we assert the routing call only.
const routeMessageToAgentMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./monitor-handler.js", () => ({
  routeMessageToAgent: (...args: unknown[]) => routeMessageToAgentMock(...args),
  createZoomMessageHandler: () => async () => {},
}));
vi.mock("./channel-memory.js", () => ({
  copyDocToCustomer: async () => {},
  ensureCustomerDir: async () => {},
  resolveWorkspaceDirForAgent: () => "/tmp/ws",
}));

import { createUploadRoutes, MAX_UPLOAD_BYTES } from "./upload-handler.js";
import { isWithinUploadDir, resolveZoomUploadDir } from "./upload-path.js";
import { createUploadToken, peekUploadToken } from "./upload-tokens.js";

const noopLog = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
} as never;

function makeRes() {
  const out: { code: number; body?: unknown } = { code: 200 };
  const res = {
    status(code: number) {
      out.code = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
    headersSent: false,
  };
  return { res, out };
}

function tokenCtx() {
  return {
    conversationId: "conv-1",
    userJid: "user@xmpp.zoom.us",
    isDirect: true,
  };
}

describe("isWithinUploadDir", () => {
  const uploadDir = resolveZoomUploadDir();

  it("accepts a file inside the uploads dir", () => {
    expect(isWithinUploadDir(path.join(uploadDir, "tok123", "doc.docx"))).toBe(true);
  });

  it("rejects the uploads dir itself, outside paths, sibling-prefix dirs, and traversal", () => {
    expect(isWithinUploadDir(uploadDir)).toBe(false);
    expect(isWithinUploadDir("/etc/passwd")).toBe(false);
    // A naive startsWith() check would accept this sibling directory.
    expect(isWithinUploadDir(`${uploadDir}-evil/doc.docx`)).toBe(false);
    expect(isWithinUploadDir(path.join(uploadDir, "..", "secrets.json"))).toBe(false);
  });
});

describe("upload handlePost size cap", () => {
  beforeEach(() => {
    routeMessageToAgentMock.mockClear();
  });
  afterEach(() => {
    fs.rmSync(resolveZoomUploadDir(), { recursive: true, force: true });
  });

  function buildRoutes() {
    return createUploadRoutes({ cfg: {}, log: noopLog } as never);
  }

  it("rejects an oversize file with 413 BEFORE consuming the token, writes nothing", async () => {
    const routes = buildRoutes();
    const token = createUploadToken(tokenCtx());
    const oversize = Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString("base64");
    const { res, out } = makeRes();

    await routes.handlePost(
      {
        body: {
          token,
          filename: "big.bin",
          mimeType: "application/octet-stream",
          size: 1,
          data: oversize,
        },
      } as never,
      res as never,
    );

    expect(out.code).toBe(413);
    // Token survives the rejected attempt — the user keeps their upload link.
    expect(peekUploadToken(token)).toBeDefined();
    // Nothing was written to disk for this token.
    expect(fs.existsSync(path.join(resolveZoomUploadDir(), token))).toBe(false);
    expect(routeMessageToAgentMock).not.toHaveBeenCalled();
  });

  it("accepts a small file: writes under the uploads dir, consumes the token, routes to the agent", async () => {
    const routes = buildRoutes();
    const token = createUploadToken(tokenCtx());
    const data = Buffer.from("hello upload").toString("base64");
    const { res, out } = makeRes();

    await routes.handlePost(
      { body: { token, filename: "note.txt", mimeType: "text/plain", size: 12, data } } as never,
      res as never,
    );

    expect(out.code).toBe(200);
    expect(out.body).toMatchObject({ ok: true });
    const tokenDir = path.join(resolveZoomUploadDir(), token);
    const files = fs.readdirSync(tokenDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/note\.txt$/);
    // Single-use: the token is consumed.
    expect(peekUploadToken(token)).toBeUndefined();
    expect(routeMessageToAgentMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid token with 401 and writes nothing", async () => {
    const routes = buildRoutes();
    const { res, out } = makeRes();
    await routes.handlePost(
      {
        body: {
          token: "not-a-real-token",
          filename: "x.txt",
          mimeType: "text/plain",
          size: 1,
          data: Buffer.from("x").toString("base64"),
        },
      } as never,
      res as never,
    );
    expect(out.code).toBe(401);
    expect(routeMessageToAgentMock).not.toHaveBeenCalled();
  });
});
