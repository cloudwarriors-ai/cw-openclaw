export const optionalBundledClusters = [
  "2fa-github",
  "acpx",
  "bigheadbot",
  "claude-mem",
  "cloudflow-support",
  "devtools",
  "diagnostics-otel",
  "diffs",
  "external-org-autopilot",
  "googlechat",
  "matrix",
  "memory-lancedb",
  "msteams",
  "nostr",
  "pulsebot",
  "tesseract",
  "tlon",
  "twitch",
  "ui",
  "zalouser",
  "zoomwarriors",
  "zoomwarriors-write",
  "zoomwarriorssupportbot",
];

export const optionalBundledClusterSet = new Set(optionalBundledClusters);

export const OPTIONAL_BUNDLED_BUILD_ENV = "OPENCLAW_INCLUDE_OPTIONAL_BUNDLED";

export function isOptionalBundledCluster(cluster) {
  return optionalBundledClusterSet.has(cluster);
}

export function shouldIncludeOptionalBundledClusters(env = process.env) {
  return env[OPTIONAL_BUNDLED_BUILD_ENV] === "1";
}

export function shouldBuildBundledCluster(cluster, env = process.env) {
  return shouldIncludeOptionalBundledClusters(env) || !isOptionalBundledCluster(cluster);
}
