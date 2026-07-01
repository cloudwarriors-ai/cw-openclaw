#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const configPath = process.argv[2] || "/root/.openclaw/openclaw.json";
const bundleDir = path.dirname(new URL(import.meta.url).pathname);
const fragmentPath = process.argv[3] || path.join(bundleDir, "openclaw.presales-ops.fragment.json");

const peChannel = process.env.PE_SUPPORT_ZOOM_CHANNEL_ID || "";
const bigheadChannel = process.env.BIGHEAD_SUPPORT_ZOOM_CHANNEL_ID || "";

if (!peChannel || !bigheadChannel) {
  console.error("Missing PE_SUPPORT_ZOOM_CHANNEL_ID or BIGHEAD_SUPPORT_ZOOM_CHANNEL_ID.");
  process.exit(2);
}

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const config = readJson(configPath);
const fragmentRaw = fs
  .readFileSync(fragmentPath, "utf8")
  .replaceAll("<PE_SUPPORT_ZOOM_CHANNEL_ID>", peChannel)
  .replaceAll("<BIGHEAD_SUPPORT_ZOOM_CHANNEL_ID>", bigheadChannel);
const fragment = JSON.parse(fragmentRaw);

config.agents = config.agents || {};
config.agents.list = Array.isArray(config.agents.list) ? config.agents.list : [];
config.bindings = Array.isArray(config.bindings) ? config.bindings : [];

const upsertById = (items, incoming) => {
  for (const item of incoming) {
    const index = items.findIndex((existing) => existing && existing.id === item.id);
    if (index >= 0) {
      items[index] = item;
    } else {
      items.push(item);
    }
  }
};

const sameBinding = (left, right) => JSON.stringify(left) === JSON.stringify(right);

upsertById(config.agents.list, fragment.agents || []);
for (const binding of fragment.bindings || []) {
  const withoutSameAgentChannel = config.bindings.filter((existing) => {
    const sameAgent = existing?.agentId === binding.agentId;
    const sameChannel = existing?.match?.channel === binding.match?.channel;
    return !(sameAgent && sameChannel);
  });
  if (!withoutSameAgentChannel.some((existing) => sameBinding(existing, binding))) {
    withoutSameAgentChannel.push(binding);
  }
  config.bindings = withoutSameAgentChannel;
}

const backupPath = `${configPath}.bak-presales-ops-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(configPath, backupPath);
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(`Updated ${configPath}`);
console.log(`Backup: ${backupPath}`);
console.log(`Agents upserted: ${(fragment.agents || []).map((agent) => agent.id).join(", ")}`);
console.log(
  `Bindings upserted: ${(fragment.bindings || []).map((binding) => binding.agentId).join(", ")}`,
);
