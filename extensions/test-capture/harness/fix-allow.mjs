// One-shot, idempotent box-config pairing for S1 (optional-tool scoping).
// Adds each bot's plugin-id to its agent tools.allow so optional:true tools
// stay visible to the bot's own agent (isOptionalToolAllowed passes when the
// allowlist contains the plugin id). Backs up first; only adds if missing.
import fs from "node:fs";

const CFG = "/root/.openclaw/openclaw.json";
const BOTS = ["bigheadbot", "pulsebot", "zoomwarriorssupportbot", "cloudflow-support"];

const raw = fs.readFileSync(CFG, "utf8");
const j = JSON.parse(raw);
const list = (j.agents && j.agents.list) || [];

const bak = `${CFG}.bak-${Date.now()}`;
fs.writeFileSync(bak, raw);

const changed = [];
for (const b of BOTS) {
  const a = list.find((x) => (x.id || x.agentId) === b);
  if (!a) {
    changed.push(`${b}: NO AGENT (skipped)`);
    continue;
  }
  a.tools = a.tools || {};
  const allow = (a.tools.allow = a.tools.allow || []);
  if (allow.includes(b)) {
    changed.push(`${b}: already present`);
  } else {
    allow.push(b);
    changed.push(`${b}: added plugin-id (allow now ${allow.length})`);
  }
}

fs.writeFileSync(CFG, `${JSON.stringify(j, null, 2)}\n`);
// Re-validate the written file parses.
JSON.parse(fs.readFileSync(CFG, "utf8"));
console.log(`backup=${bak}`);
for (const c of changed) console.log(c);
console.log("OK");
