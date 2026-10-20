import { execFileSync } from "node:child_process";
// Stage a completed standard tsdown build for the isolated Noob bot image.
// Run `node scripts/tsdown-build.mjs` first. Never copy generated plugin bundles.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const output = path.join(root, "planning_artifacts/vip-dev-bot-alignment");
const destination = path.join(output, "core-runtime");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const files = {};
// Local operator custody assumes no concurrent adversarial filesystem writer.
// Reject preexisting ancestry aliases and hardlinks BEFORE creating/copying.
const canonicalRoot = await fs.realpath(root);
let ancestor = canonicalRoot;
for (const segment of ["planning_artifacts", "vip-dev-bot-alignment", "core-runtime"]) {
  ancestor = path.join(ancestor, segment);
  try {
    const info = await fs.lstat(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Unsafe staging ancestry: ${ancestor}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    await fs.mkdir(ancestor, { mode: 0o700 });
  }
}
async function preflight(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const info = await fs.lstat(target);
    if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) {
      throw new Error(`Unsafe preexisting staging link: ${target}`);
    }
    if (info.isDirectory()) {
      await preflight(target);
    } else if (!info.isFile()) {
      throw new Error(`Unsafe preexisting staging node: ${target}`);
    }
  }
}
await preflight(destination);
try {
  const info = await fs.lstat(path.join(output, "core-build-manifest.json"));
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("Unsafe preexisting build manifest");
  }
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}
async function stage(directory, prefix = "") {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (relative.split("/")[0] === "extensions" || relative.split("/").includes("node_modules")) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Unexpected build symlink: ${relative}`);
    }
    const source = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await stage(source, relative);
    } else if (entry.isFile()) {
      const target = path.join(destination, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
      files[relative] = sha(await fs.readFile(source));
    }
  }
}
await stage(path.join(root, "dist"));
// Refuse stale outputs from a previous build rather than packaging them silently.
async function stagedFiles(directory, prefix = "") {
  const names = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Unexpected staged symlink: ${relative}`);
    }
    if (entry.isDirectory()) {
      names.push(...(await stagedFiles(path.join(directory, entry.name), relative)));
    } else if (entry.isFile()) {
      names.push(relative);
    }
  }
  return names;
}
if (
  JSON.stringify((await stagedFiles(destination)).toSorted()) !==
  JSON.stringify(Object.keys(files).toSorted())
) {
  throw new Error("Stale core staging files; inspect the task-owned output before rebuilding");
}
const transcriptFiles = [];
for (const name of Object.keys(files)) {
  if (
    /^transcript-[^/]+\.js$/.test(name) &&
    (await fs.readFile(path.join(destination, name), "utf8")).includes("NATIVE_CATALOG_SELECTORS")
  ) {
    transcriptFiles.push(name);
  }
}
if (transcriptFiles.length !== 1) {
  throw new Error("Build must contain exactly one corrected transcript module");
}
const inventory = [];
for (const name of execFileSync(
  "git",
  ["ls-files", "-z", "src", "scripts", "packages", "extensions"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)) {
  const info = await fs.lstat(name);
  if (info.isFile()) {
    inventory.push([name, sha(await fs.readFile(name))]);
  }
}
const sourceSha256 = {};
for (const name of [
  "src/agents/transcript-redact.ts",
  "pnpm-lock.yaml",
  "tsdown.config.ts",
  "scripts/tsdown-build.mjs",
]) {
  sourceSha256[name] = sha(await fs.readFile(name));
}
const manifest = {
  base_image: "sha256:3ac885c9b5698038c608a2ada5de85f1b8c9c78a2b477561aba55c4445a980b9",
  source_head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  source_sha256: sourceSha256,
  node: process.version,
  tsdown_version: JSON.parse(await fs.readFile("node_modules/tsdown/package.json", "utf8")).version,
  build_command: "node scripts/tsdown-build.mjs",
  stage_command: "node scripts/stage-noob-core-runtime.mjs",
  source_inventory_sha256: sha(JSON.stringify(inventory)),
  source_inventory_count: inventory.length,
  compiled_transcript: transcriptFiles[0],
  outputs: files,
  preserved_vip_bundle_sha256: "1ec3a4ed5e8e9a33eacc203c1689d80dd58fce8f9004de487173b54db198fc26",
  preserved_zoom_bundle_sha256: "f60202de0202b1690626bdabe17b72dea2afe93deb470c2012ba5cf7d2fbf26a",
};
await fs.writeFile(
  path.join(output, "core-build-manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(
  JSON.stringify({ outputs: Object.keys(files).length, compiled_transcript: transcriptFiles[0] }),
);
