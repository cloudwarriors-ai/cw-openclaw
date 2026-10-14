/** Offline packaging check. No runtime profile/token reads or deployment authority. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseBackendProfile } from "../src/backend-profile.js";

const MAX_BYTES = 64 * 1024;
const EVIDENCE_KEYS = [
  "publicationGate",
  "mainDeployGate",
  "builds",
  "migrationBackup",
  "identity",
  "workspaceOwnership",
  "channel",
  "auditPersistence",
  "connectedUat",
  "releaseAuthorization",
] as const;
const EXTERNAL_CHECKS = EVIDENCE_KEYS.map((key) => `operator_verification:${key}`);

type RecordValue = Record<string, unknown>;
export type PreflightReport = {
  templateValid: boolean;
  releaseReady: false;
  errors: string[];
  pendingChecks: string[];
  scope: "offline-declarations-only";
};
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: RecordValue, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function containerPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.endsWith("/") &&
    !/[\\\s]/u.test(value) &&
    [...value].every((character) => character.charCodeAt(0) > 31) &&
    posix.normalize(value) === value &&
    value !== "/"
  );
}
function within(parent: string, child: string): boolean {
  const relative = posix.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith("../") &&
    !posix.isAbsolute(relative)
  );
}
function imageDigest(value: unknown): boolean {
  return typeof value === "string" && /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/u.test(value);
}
function commit(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) && !/^0+$/u.test(value);
}
function evidenceReference(value: unknown): boolean {
  // References are labels only: never opened, fetched, or interpreted as credentials.
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/u.test(value) &&
    !value.split("/").includes("..")
  );
}

export function validateDeclarations(profileRaw: string, manifestRaw: string): PreflightReport {
  const errors: string[] = [];
  const pendingChecks: string[] = [...EXTERNAL_CHECKS];
  const result = (): PreflightReport => ({
    templateValid: errors.length === 0,
    releaseReady: false,
    errors,
    pendingChecks,
    scope: "offline-declarations-only",
  });
  if (Buffer.byteLength(profileRaw) > MAX_BYTES || Buffer.byteLength(manifestRaw) > MAX_BYTES) {
    errors.push("input_too_large");
    return result();
  }
  const profile = parseBackendProfile(profileRaw);
  if (
    "error" in profile ||
    profile.profile.env !== "prod" ||
    profile.profile.mode !== "read-only" ||
    profile.profile.authMode !== "service-token" ||
    profile.profile.digestEnabled
  ) {
    errors.push("profile_not_production_readonly");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    errors.push("manifest_invalid_json");
    return result();
  }
  if (
    !record(manifest) ||
    !exactKeys(manifest, [
      "schemaVersion",
      "backend",
      "plugin",
      "rollback",
      "runtime",
      "evidence",
    ]) ||
    manifest.schemaVersion !== 1
  ) {
    errors.push("manifest_invalid_shape");
    return result();
  }
  for (const key of ["backend", "plugin"] as const) {
    const pair = manifest[key];
    if (!record(pair) || !exactKeys(pair, ["commit", "image"])) {
      errors.push(`${key}_invalid_shape`);
      continue;
    }
    for (const field of ["commit", "image"] as const) {
      if (pair[field] === null) {
        pendingChecks.push(`missing:${key}.${field}`);
      } else if (!(field === "commit" ? commit(pair[field]) : imageDigest(pair[field]))) {
        errors.push(`${key}_${field}_invalid`);
      }
    }
  }
  const rollback = manifest.rollback;
  if (
    !record(rollback) ||
    !exactKeys(rollback, [
      "backendCommit",
      "backendImage",
      "pluginCommit",
      "pluginImage",
      "profileEvidence",
    ])
  ) {
    errors.push("rollback_invalid_shape");
  } else {
    for (const field of [
      "backendCommit",
      "backendImage",
      "pluginCommit",
      "pluginImage",
      "profileEvidence",
    ] as const) {
      const value = rollback[field];
      if (value === null) {
        pendingChecks.push(`missing:rollback.${field}`);
      } else if (
        !(field.endsWith("Commit")
          ? commit(value)
          : field.endsWith("Image")
            ? imageDigest(value)
            : evidenceReference(value))
      ) {
        errors.push(`rollback_${field}_invalid`);
      }
    }
  }
  const runtime = manifest.runtime;
  if (
    !record(runtime) ||
    !exactKeys(runtime, [
      "mountSource",
      "mountTarget",
      "workspace",
      "profileFile",
      "tokenFile",
      "channelEnv",
    ])
  ) {
    errors.push("runtime_invalid_shape");
  } else {
    if (runtime.mountSource !== "./.data/openclaw" || runtime.mountTarget !== "/root/.openclaw") {
      errors.push("runtime_not_existing_mount");
    }
    if (!containerPath(runtime.workspace) || !within("/root/.openclaw", runtime.workspace)) {
      errors.push("runtime_workspace_escape");
    }
    if (
      runtime.profileFile !== "scopelybot-backend.json" ||
      runtime.tokenFile !== "scopelybot-ops-token" ||
      runtime.channelEnv !== "SCOPELYBOT_ZOOM_CHANNEL"
    ) {
      errors.push("runtime_reference_invalid");
    }
  }
  const evidence = manifest.evidence;
  if (!record(evidence) || !exactKeys(evidence, EVIDENCE_KEYS)) {
    errors.push("evidence_invalid_shape");
  } else {
    for (const key of EVIDENCE_KEYS) {
      if (evidence[key] === null) {
        pendingChecks.push(`missing:evidence.${key}`);
      } else if (!evidenceReference(evidence[key])) {
        errors.push(`evidence_${key}_invalid`);
      }
    }
  }
  return result();
}

function readExplicitFile(file: string): string {
  // Only the two command-line inputs are opened. Never inspect a runtime token.
  if (basename(file) === "scopelybot-ops-token") {
    throw new Error("reserved_file");
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      throw new Error("invalid_file");
    }
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) {
        break;
      }
      size += count;
    }
    if (size > MAX_BYTES) {
      throw new Error("invalid_file");
    }
    return bytes.subarray(0, size).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function runPreflight(args: string[]): { report: PreflightReport; exitCode: number } {
  const fail = (error: string) => ({
    report: {
      templateValid: false,
      releaseReady: false as const,
      errors: [error],
      pendingChecks: [...EXTERNAL_CHECKS],
      scope: "offline-declarations-only" as const,
    },
    exitCode: 1,
  });
  if (
    (args.length !== 2 && args.length !== 3) ||
    (args.length === 3 && args[2] !== "--require-ready")
  ) {
    return fail("usage:profile_file_manifest_file_optional_require_ready");
  }
  let profile: string;
  let manifest: string;
  try {
    profile = readExplicitFile(args[0]);
    manifest = readExplicitFile(args[1]);
  } catch {
    // Never echo file paths, input contents, filesystem exceptions, or parser values.
    return fail("input_unreadable_or_unsafe");
  }
  const report = validateDeclarations(profile, manifest);
  // No declaration, even a filled evidence label, is a verified live release gate.
  return { report, exitCode: !report.templateValid ? 1 : args[2] === "--require-ready" ? 2 : 0 };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { report, exitCode } = runPreflight(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = exitCode;
}
