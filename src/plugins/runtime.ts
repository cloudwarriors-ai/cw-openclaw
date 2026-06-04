import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";

const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type RegistryState = {
  registry: PluginRegistry | null;
  httpRouteRegistry: PluginRegistry | null;
  httpRouteRegistryPinned: boolean;
  key: string | null;
  version: number;
};

const state: RegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [REGISTRY_STATE]?: RegistryState;
  };
  if (!globalState[REGISTRY_STATE]) {
    globalState[REGISTRY_STATE] = {
      registry: createEmptyPluginRegistry(),
      httpRouteRegistry: null,
      httpRouteRegistryPinned: false,
      key: null,
      version: 0,
    };
  }
  return globalState[REGISTRY_STATE];
})();

export function setActivePluginRegistry(registry: PluginRegistry, cacheKey?: string) {
  state.registry = registry;
  if (!state.httpRouteRegistryPinned) {
    state.httpRouteRegistry = registry;
  }
  state.key = cacheKey ?? null;
  state.version += 1;
}

// Drain hooks from a registry being discarded. Internal hooks live on a globalThis
// singleton, so the loader must call this when an entry is evicted from the LRU
// cache (or when a non-cached snapshot load completes), otherwise the hook handler
// closures leak forever. Best-effort: never throws.
export function drainPluginRegistryHooks(registry: PluginRegistry): void {
  const unregisters = registry.hookUnregisters;
  if (!unregisters || unregisters.length === 0) {
    return;
  }
  for (const unregister of unregisters) {
    try {
      unregister();
    } catch {
      // Sibling teardowns must still run.
    }
  }
  unregisters.length = 0;
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return state.registry;
}

export function requireActivePluginRegistry(): PluginRegistry {
  if (!state.registry) {
    state.registry = createEmptyPluginRegistry();
    if (!state.httpRouteRegistryPinned) {
      state.httpRouteRegistry = state.registry;
    }
    state.version += 1;
  }
  return state.registry;
}

export function pinActivePluginHttpRouteRegistry(registry: PluginRegistry) {
  state.httpRouteRegistry = registry;
  state.httpRouteRegistryPinned = true;
}

export function releasePinnedPluginHttpRouteRegistry(registry?: PluginRegistry) {
  if (registry && state.httpRouteRegistry !== registry) {
    return;
  }
  state.httpRouteRegistryPinned = false;
  state.httpRouteRegistry = state.registry;
}

export function getActivePluginHttpRouteRegistry(): PluginRegistry | null {
  return state.httpRouteRegistry ?? state.registry;
}

export function requireActivePluginHttpRouteRegistry(): PluginRegistry {
  const existing = getActivePluginHttpRouteRegistry();
  if (existing) {
    return existing;
  }
  const created = requireActivePluginRegistry();
  state.httpRouteRegistry = created;
  return created;
}

export function resolveActivePluginHttpRouteRegistry(fallback: PluginRegistry): PluginRegistry {
  const routeRegistry = getActivePluginHttpRouteRegistry();
  if (!routeRegistry) {
    return fallback;
  }
  const routeCount = routeRegistry.httpRoutes?.length ?? 0;
  const fallbackRouteCount = fallback.httpRoutes?.length ?? 0;
  if (routeCount === 0 && fallbackRouteCount > 0) {
    return fallback;
  }
  return routeRegistry;
}

export function getActivePluginRegistryKey(): string | null {
  return state.key;
}

export function getActivePluginRegistryVersion(): number {
  return state.version;
}
