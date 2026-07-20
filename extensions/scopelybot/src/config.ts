/** Shared, fail-closed configuration contract for ScopelyBot tools and writes. */

export interface ScopelyBotConfig {
  scopelyRepos?: string[];
  serviceContainers?: string[];
  writeApproverIds?: string[];
}

export function resolveScopelyBotConfig(
  rootConfig: unknown,
  override?: ScopelyBotConfig,
): ScopelyBotConfig {
  if (override) return override;
  const root = rootConfig as {
    plugins?: { entries?: { scopelybot?: { config?: ScopelyBotConfig } } };
  };
  return (
    root.plugins?.entries?.scopelybot?.config ?? {
      scopelyRepos: ["cloudwarriors-ai/scopely"],
    }
  );
}

export function configuredServiceContainers(config: ScopelyBotConfig): string[] {
  const values = config.serviceContainers?.map((value) => value.trim()).filter(Boolean) ?? [];
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(
      "Scopely serviceContainers must be a non-empty, duplicate-free exact allowlist",
    );
  }
  return values;
}

export function configuredWriteApprovers(config: ScopelyBotConfig): string[] {
  return [
    ...new Set((config.writeApproverIds ?? []).map((value) => value.trim().toLowerCase())),
  ].filter(Boolean);
}
