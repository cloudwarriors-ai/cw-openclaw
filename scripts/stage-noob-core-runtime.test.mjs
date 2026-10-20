import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./stage-noob-core-runtime.mjs", import.meta.url));
const artifacts = fileURLToPath(
  new URL("../planning_artifacts/vip-dev-bot-alignment/", import.meta.url),
);
for (const kind of ["symlink", "hardlink", "manifest"]) {
  test(`refuses preexisting ${kind} before any outside write`, async () => {
    const root = await fs.mkdtemp(path.join(artifacts, "stage-security-test-"));
    try {
      const output = path.join(root, "planning_artifacts/vip-dev-bot-alignment");
      const destination = path.join(output, "core-runtime");
      await fs.mkdir(destination, { recursive: true });
      await fs.mkdir(path.join(root, "dist"));
      const protectedFile = path.join(root, "outside-staging.txt");
      await fs.writeFile(protectedFile, "unchanged");
      const target =
        kind === "manifest"
          ? path.join(output, "core-build-manifest.json")
          : path.join(destination, "asset.js");
      if (kind === "hardlink") {
        await fs.link(protectedFile, target);
      } else {
        await fs.symlink(protectedFile, target);
      }
      await fs.writeFile(path.join(root, "dist/asset.js"), "must never overwrite protected file");
      const child = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
      assert.equal(child.status, 1);
      assert.match(child.stderr, /Unsafe preexisting/);
      assert.equal(await fs.readFile(protectedFile, "utf8"), "unchanged");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
