import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const srcDir = path.join(appDir, "src", "client");
const destDir = path.join(appDir, "dist", "client");

await mkdir(destDir, { recursive: true });
await cp(srcDir, destDir, { recursive: true });
