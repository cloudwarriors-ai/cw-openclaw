// One-shot, idempotent PROD plugin policy for the box's openclaw.json.
// Merges the production deny list into plugins.deny so the loader never
// activates extensions excluded from prod (resolveEffectivePluginIds drops
// denied ids; enable.ts refuses to re-enable them). Backs up first; only adds
// missing ids; never removes operator-added entries.
//
// Run ON the box (config lives in runtime state, not the repo):
//   node deploy/prod-plugin-policy.mjs [/path/to/openclaw.json]
import fs from "node:fs";

const CFG = process.argv[2] ?? "/root/.openclaw/openclaw.json";

// Excluded from prod (decision 2026-06-09): claude-mem (bun fork + chroma dep),
// slm-pipeline/slm-supervisor (HTTP routes, dev-only), 2fa-github (dead-code
// enforcement gap, not shipped until fixed), test-capture (test harness;
// also inert without OPENCLAW_TEST_CAPTURE=1 which prod compose never sets).
const PROD_DENY = ["claude-mem", "slm-pipeline", "slm-supervisor", "2fa-github", "test-capture"];

const raw = fs.readFileSync(CFG, "utf8");
const j = JSON.parse(raw);

const bak = `${CFG}.bak-${Date.now()}`;
fs.writeFileSync(bak, raw);

j.plugins = j.plugins || {};
const deny = (j.plugins.deny = j.plugins.deny || []);

const report = [];
for (const id of PROD_DENY) {
  if (deny.includes(id)) {
    report.push(`${id}: already denied`);
  } else {
    deny.push(id);
    report.push(`${id}: added to plugins.deny`);
  }
}

fs.writeFileSync(CFG, `${JSON.stringify(j, null, 2)}\n`);
// Re-validate the written file parses.
JSON.parse(fs.readFileSync(CFG, "utf8"));
console.log(`backup=${bak}`);
for (const line of report) console.log(line);
console.log(`plugins.deny now: ${JSON.stringify(deny)}`);
console.log("OK");
