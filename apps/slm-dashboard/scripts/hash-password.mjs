import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2] ?? "";
if (!password) {
  process.stderr.write("Usage: pnpm --dir apps/slm-dashboard hash-password '<password>'\n");
  process.exit(1);
}

const n = 16_384;
const r = 8;
const p = 1;
const salt = randomBytes(16);
const digest = scryptSync(password, salt, 64, { N: n, r, p });
const hash = ["scrypt", String(n), String(r), String(p), salt.toString("base64"), digest.toString("base64")].join(
  "$",
);

process.stdout.write(`${hash}\n`);
