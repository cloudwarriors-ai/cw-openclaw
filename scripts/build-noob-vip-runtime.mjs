// Rebuild ONLY the VIP plugin for the matched, immutable Noob gateway image.
// External packages (including the gateway SDK) retain their runtime identity.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const output = path.join(root, "planning_artifacts/vip-dev-bot-alignment");
await fs.mkdir(output, { recursive: true });
const bundle = path.join(output, "scopelybot-runtime.js");
const result = await build({
  entryPoints: ["extensions/scopelybot/index.ts"],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: bundle,
  metafile: true,
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inputs = {};
for (const file of Object.keys(result.metafile.inputs).toSorted()) {
  if (!file.startsWith("extensions/scopelybot/") || file.includes("node_modules")) {
    throw new Error(`Unexpected bundled input: ${file}`);
  }
  inputs[file] = sha(await fs.readFile(file));
}
const manifest = {
  input_sha256: inputs,
  bundle_sha256: sha(await fs.readFile(bundle)),
  external_imports: Object.values(result.metafile.outputs).flatMap((entry) => entry.imports),
};
await fs.writeFile(path.join(output, "bundle-manifest.json"), JSON.stringify(manifest, null, 2));
await fs.writeFile(
  path.join(output, "bundle-metafile.json"),
  JSON.stringify(result.metafile, null, 2),
);
console.log(
  JSON.stringify({
    bundle_sha256: manifest.bundle_sha256,
    input_count: Object.keys(inputs).length,
  }),
);
