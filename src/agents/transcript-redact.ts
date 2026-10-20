/**
 * Agent transcript redaction helpers.
 *
 * Applies logging redaction rules to persisted messages while preserving unchanged object identity.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLoggingConfig } from "../logging/config.js";
import {
  getDefaultRedactPatterns,
  redactSensitiveFieldValue,
  isSensitiveFieldKey,
  redactSensitiveText,
} from "../logging/redact.js";
import type { AgentMessage } from "./runtime/index.js";

function resolveTranscriptRedactPatterns(patterns?: string[]) {
  return patterns && patterns.length > 0 ? [...patterns, ...getDefaultRedactPatterns()] : undefined;
}

function redactTranscriptOptions(cfg?: OpenClawConfig) {
  const configuredLogging = readLoggingConfig();
  const mode = cfg?.logging?.redactSensitive ?? configuredLogging?.redactSensitive;
  const patterns = resolveTranscriptRedactPatterns(
    cfg?.logging?.redactPatterns ?? configuredLogging?.redactPatterns,
  );
  if (mode === undefined && patterns === undefined) {
    return undefined;
  }
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(patterns !== undefined ? { patterns } : {}),
  };
}

function redactTranscriptText(value: string, cfg?: OpenClawConfig): string {
  if (cfg?.logging?.redactSensitive === "off") {
    return value;
  }
  return redactSensitiveText(value, redactTranscriptOptions(cfg));
}

function redactTranscriptStructuredFieldValue(
  key: string,
  value: string,
  cfg?: OpenClawConfig,
): string {
  if (cfg?.logging?.redactSensitive === "off") {
    return value;
  }
  return redactSensitiveFieldValue(key, value, redactTranscriptOptions(cfg));
}

// These native catalog selectors are business identifiers, not credentials.
// Scope the exception to literal tool names and direct schema argument paths.
const NATIVE_CATALOG_SELECTORS: Readonly<Record<string, readonly string[]>> = {
  scopely_create_pricing_item: ["vendor_key", "pricing_key"],
  scopely_update_pricing_item: ["vendor_key", "pricing_key"],
  scopely_create_scoping_card: ["vendor_key"],
  scopely_update_scoping_card: ["vendor_key", "card_key"],
  scopely_delete_scoping_card: ["vendor_key", "card_key"],
  scopely_update_project_type: ["vendor_key"],
  scopely_update_deployment_type: ["vendor_key"],
  scopely_list_project_types: ["vendor_key"],
  scopely_list_deployment_types: ["vendor_key"],
  scopely_list_scoping_cards: ["vendor_key"],
  scopely_get_scoping_card: ["vendor_key", "card_key"],
  scopely_get_vendor: ["vendor_key"],
  scopely_vendor_config: ["vendor_key"],
  scopely_list_pricing_defaults: ["vendor_key"],
  scopely_list_pricing_items: ["vendor_key"],
};

function isNativeBusinessSelector(tool: string, key: string, value: unknown, cfg?: OpenClawConfig) {
  if (!NATIVE_CATALOG_SELECTORS[tool]?.includes(key) || typeof value !== "string") {
    return false;
  }
  const limit = key === "pricing_key" ? 100 : 50;
  if (!value || value.length > limit || !/^[-a-zA-Z0-9_]+$/.test(value)) {
    return false;
  }
  if (/^zwops_/i.test(value) || redactTranscriptText(value, cfg) !== value) {
    return false;
  }
  // A syntactically valid slug can still be an actual configured credential.
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && isSensitiveFieldKey(name) && secret === value) {
      return false;
    }
  }
  return true;
}

function isPlainTranscriptObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactTranscriptStructuredValue(
  value: unknown,
  cfg?: OpenClawConfig,
  fieldKey?: string,
  seen: WeakSet<object> = new WeakSet<object>(),
  nativeToolArguments?: string,
  nativeToolBlocks: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    if (fieldKey) {
      return redactTranscriptStructuredFieldValue(fieldKey, value, cfg);
    }
    return redactTranscriptText(value, cfg);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    let changed = false;
    const redacted = value.map((item) => {
      const next = redactTranscriptStructuredValue(
        item,
        cfg,
        fieldKey,
        seen,
        undefined,
        nativeToolBlocks,
      );
      changed ||= next !== item;
      return next;
    });
    seen.delete(value);
    return changed ? redacted : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    // Avoid recursive transcript payloads from escaping redaction or crashing
    // persistence; circular refs serialize as a stable marker.
    return "[Circular]";
  }
  if (!isPlainTranscriptObject(value)) {
    // Non-plain instances can carry runtime state; leave them untouched instead
    // of cloning unexpected prototypes into transcripts.
    return value;
  }

  seen.add(value);
  const source = value;
  let next: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(source)) {
    // Exempt only direct arguments of an identified native tool call. Never
    // propagate this context into nested env/headers/credential objects.
    const tool =
      nativeToolBlocks.has(source) &&
      source.type === "toolCall" &&
      typeof source.name === "string" &&
      Object.hasOwn(NATIVE_CATALOG_SELECTORS, source.name) &&
      key === "arguments"
        ? source.name
        : undefined;
    const redacted =
      nativeToolArguments && isNativeBusinessSelector(nativeToolArguments, key, item, cfg)
        ? item
        : redactTranscriptStructuredValue(item, cfg, key, seen, tool, nativeToolBlocks);
    if (redacted === item) {
      continue;
    }
    next ??= { ...source };
    next[key] = redacted;
  }
  seen.delete(value);
  return next ?? value;
}

/** Return a redacted transcript message according to logging config. */
export function redactTranscriptMessage(message: AgentMessage, cfg?: OpenClawConfig): AgentMessage {
  if (cfg?.logging?.redactSensitive === "off") {
    return message;
  }
  const nativeToolBlocks = new WeakSet<object>();
  const root = message as unknown as { role?: string; content?: unknown };
  if (root.role === "assistant" && Array.isArray(root.content)) {
    for (const block of root.content) {
      if (block && typeof block === "object" && block.type === "toolCall") {
        nativeToolBlocks.add(block);
      }
    }
  }
  return redactTranscriptStructuredValue(
    message,
    cfg,
    undefined,
    new WeakSet(),
    undefined,
    nativeToolBlocks,
  ) as AgentMessage;
}
