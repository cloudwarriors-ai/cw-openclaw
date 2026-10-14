import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({
  active: false,
  allowed: [] as string[],
  opened: [] as string[],
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const guarded = { ...actual };
  for (const name of [
    "writeFileSync",
    "appendFileSync",
    "mkdirSync",
    "renameSync",
    "unlinkSync",
    "rmSync",
    "chmodSync",
    "truncateSync",
    "createWriteStream",
  ] as const) {
    Object.assign(guarded, {
      [name]: (...args: unknown[]) => {
        if (guard.active) {
          throw new Error("forbidden filesystem mutation");
        }
        return Reflect.apply(actual[name], actual, args);
      },
    });
  }
  guarded.openSync = (path, flags, mode) => {
    if (guard.active) {
      const name = String(path);
      if (
        !guard.allowed.includes(name) ||
        typeof flags !== "number" ||
        flags &
          (actual.constants.O_WRONLY |
            actual.constants.O_RDWR |
            actual.constants.O_CREAT |
            actual.constants.O_TRUNC)
      ) {
        throw new Error("forbidden filesystem open");
      }
      guard.opened.push(name);
    }
    return actual.openSync(path, flags, mode);
  };
  return guarded;
});
vi.mock("../src/audit.js", () => ({
  auditEventBestEffort: () => {
    throw new Error("forbidden audit write");
  },
  noteAuditPolicy: () => {
    throw new Error("forbidden audit policy mutation");
  },
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const guarded = { ...actual };
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ] as const) {
    Object.assign(guarded, {
      [name]: (...args: unknown[]) => {
        if (guard.active) {
          throw new Error("forbidden subprocess");
        }
        return Reflect.apply(actual[name], actual, args);
      },
    });
  }
  return guarded;
});
vi.mock("node:http", () => ({
  request: () => {
    throw new Error("forbidden HTTP");
  },
  get: () => {
    throw new Error("forbidden HTTP");
  },
}));
vi.mock("node:https", () => ({
  request: () => {
    throw new Error("forbidden HTTPS");
  },
  get: () => {
    throw new Error("forbidden HTTPS");
  },
}));
vi.mock("node:net", () => ({
  connect: () => {
    throw new Error("forbidden socket");
  },
  createConnection: () => {
    throw new Error("forbidden socket");
  },
}));

import { runPreflight, validateDeclarations } from "./preflight-readonly.js";

const docs = fileURLToPath(new URL("../docs/", import.meta.url));
const profileRaw = fs.readFileSync(join(docs, "backend.prod-readonly.example.json"), "utf8");
const manifestRaw = fs.readFileSync(join(docs, "changeover-manifest.example.json"), "utf8");
const profile = JSON.parse(profileRaw) as Record<string, unknown>;
const manifest = () => JSON.parse(manifestRaw);
let directory: string;
let profileFile: string;
let manifestFile: string;
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "scopely-preflight-"));
  profileFile = join(directory, "profile.json");
  manifestFile = join(directory, "manifest.json");
  fs.writeFileSync(profileFile, profileRaw);
  fs.writeFileSync(manifestFile, manifestRaw);
  guard.allowed = [profileFile, manifestFile];
  guard.opened = [];
  vi.stubGlobal("fetch", () => {
    throw new Error("forbidden fetch");
  });
});
afterEach(() => {
  guard.active = false;
  vi.unstubAllGlobals();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("offline release preflight", () => {
  it("accepts the checked-in template without granting release readiness or touching runtime state", () => {
    guard.active = true;
    const result = runPreflight([profileFile, manifestFile]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({ templateValid: true, releaseReady: false, errors: [] });
    expect(result.report.pendingChecks).toContain("missing:backend.commit");
    expect(result.report.pendingChecks).toContain("operator_verification:identity");
    expect(guard.opened).toEqual([profileFile, manifestFile]);
  });
  it("cannot promote even a fully filled declaration to live readiness", () => {
    const value = manifest();
    for (const key of ["backend", "plugin"]) {
      value[key] = {
        commit: "a".repeat(40),
        image: `ghcr.io/example/app@sha256:${"b".repeat(64)}`,
      };
    }
    value.rollback = {
      backendCommit: "c".repeat(40),
      pluginCommit: "d".repeat(40),
      backendImage: value.backend.image,
      pluginImage: value.plugin.image,
      profileEvidence: "rollback/profile.json",
    };
    for (const key of Object.keys(value.evidence)) {
      value.evidence[key] = `evidence/${key}.json`;
    }
    fs.writeFileSync(manifestFile, JSON.stringify(value));
    guard.active = true;
    const result = runPreflight([profileFile, manifestFile, "--require-ready"]);
    expect(result.exitCode).toBe(2);
    expect(result.report.templateValid).toBe(true);
    expect(result.report.releaseReady).toBe(false);
    expect(result.report.pendingChecks).toHaveLength(10);
  });
  it.each([
    { mode: "read-write" },
    { mode: "off" },
    { authMode: "anonymous" },
    { digestEnabled: true },
    { env: "local" },
    { env: "dev" },
    { allowedHosts: ["vip.pscx.ai"] },
    { allowedHosts: ["127.0.0.1:8100"] },
    { hostHeader: "vip.localhost" },
    { baseUrl: "https://secret:password@api.vip.pscx.ai" },
    { baseUrl: "https://api.vip.pscx.ai/api" },
    { baseUrl: "https://api.vip.pscx.ai?secret=x" },
    { baseUrl: "https://api.vip.pscx.ai#secret" },
    { baseUrl: "http://api.vip.pscx.ai" },
    { maxRequestsPerMinute: 0 },
    { maxRequestsPerMinute: 601 },
  ])("refuses unsafe production profile %j", (override) => {
    expect(
      validateDeclarations(JSON.stringify({ ...profile, ...override }), manifestRaw).errors,
    ).toEqual(["profile_not_production_readonly"]);
  });
  it.each([
    "/root/.openclaw-other/workspace",
    "/root/.openclaw/../outside",
    "/root/.openclaw",
    "/tmp/workspace",
    "/root/.openclaw/work\\space",
    "/root/.openclaw//workspace",
    "/root/.openclaw/workspace/",
    "workspace",
    "/root/.openclaw/a/../../outside",
  ])("rejects workspace escape/noncanonical path %s", (workspace) => {
    const value = manifest();
    value.runtime.workspace = workspace;
    expect(validateDeclarations(profileRaw, JSON.stringify(value)).errors).toContain(
      "runtime_workspace_escape",
    );
  });
  it("allows the existing explicit workspace override inside the mount without reading it", () => {
    const value = manifest();
    value.runtime.workspace = "/root/.openclaw/workspaces/scopely";
    expect(validateDeclarations(profileRaw, JSON.stringify(value)).templateValid).toBe(true);
  });
  it.each(["short", "0".repeat(40), "A".repeat(40), "a".repeat(41)])(
    "rejects an invalid commit %s",
    (value) => {
      const data = manifest();
      data.backend.commit = value;
      expect(validateDeclarations(profileRaw, JSON.stringify(data)).errors).toContain(
        "backend_commit_invalid",
      );
    },
  );
  it.each([
    "app:latest",
    "app@sha256:short",
    "https://user:secret@host/image",
    "app@sha256:" + "z".repeat(64),
  ])("requires an immutable image digest %s", (value) => {
    const data = manifest();
    data.plugin.image = value;
    expect(validateDeclarations(profileRaw, JSON.stringify(data)).errors).toContain(
      "plugin_image_invalid",
    );
  });
  it.each(["schemaVersion", "backend", "plugin", "rollback", "runtime", "evidence"])(
    "rejects missing manifest section %s",
    (key) => {
      const data = manifest();
      delete data[key];
      expect(validateDeclarations(profileRaw, JSON.stringify(data)).errors).toContain(
        "manifest_invalid_shape",
      );
    },
  );
  it.each(["backend", "plugin", "rollback", "runtime", "evidence"])(
    "rejects unexpected or missing fields in %s",
    (key) => {
      const data = manifest();
      data[key].secret = "DO-NOT-ECHO";
      const report = validateDeclarations(profileRaw, JSON.stringify(data));
      expect(report.templateValid).toBe(false);
      expect(JSON.stringify(report)).not.toContain("DO-NOT-ECHO");
    },
  );
  it("rejects changed mounts and secret-bearing evidence references without echoing values", () => {
    const data = manifest();
    data.runtime.mountSource = "/other";
    data.evidence.identity = "op://vault/DO-NOT-ECHO/password";
    const report = validateDeclarations(profileRaw, JSON.stringify(data));
    expect(report.errors).toEqual(["runtime_not_existing_mount", "evidence_identity_invalid"]);
    expect(JSON.stringify(report)).not.toContain("DO-NOT-ECHO");
  });
  it.each(["../token", "/tmp/token", "other-token"])(
    "does not accept a runtime token path override %s",
    (tokenFile) => {
      const data = manifest();
      data.runtime.tokenFile = tokenFile;
      expect(validateDeclarations(profileRaw, JSON.stringify(data)).errors).toContain(
        "runtime_reference_invalid",
      );
    },
  );
  it.each(["{", "null", "[]", "DO-NOT-ECHO"])(
    "fails malformed inputs without copying them to diagnostics: %s",
    (raw) => {
      const report = validateDeclarations(raw, raw);
      expect(report.templateValid).toBe(false);
      expect(JSON.stringify(report)).not.toContain("DO-NOT-ECHO");
    },
  );
  it("refuses oversized input without parsing it", () => {
    expect(validateDeclarations("x".repeat(65537), manifestRaw).errors).toEqual([
      "input_too_large",
    ]);
  });
  it("refuses missing, directory, symlink and reserved token files with bounded diagnostics", () => {
    const link = join(directory, "link.json");
    fs.symlinkSync(profileFile, link);
    const token = join(directory, "scopelybot-ops-token");
    fs.writeFileSync(token, "DO-NOT-ECHO");
    for (const file of [join(directory, "missing-DO-NOT-ECHO"), directory, link, token]) {
      const result = runPreflight([file, manifestFile]);
      expect(result.exitCode).toBe(1);
      expect(result.report.errors).toEqual(["input_unreadable_or_unsafe"]);
      expect(JSON.stringify(result.report)).not.toContain("DO-NOT-ECHO");
    }
  });
  it("refuses an oversized regular file", () => {
    fs.writeFileSync(profileFile, "x".repeat(65537));
    expect(runPreflight([profileFile, manifestFile]).exitCode).toBe(1);
  });
  it.each([[], ["one"], ["one", "two", "--repair"], ["one", "two", "--require-ready", "extra"]])(
    "rejects invalid CLI argument sets %j",
    (...args) => {
      expect(runPreflight(args).exitCode).toBe(1);
    },
  );
});
