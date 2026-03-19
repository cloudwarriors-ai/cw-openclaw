// Shared root plugin-sdk surface.
// Keep this entry intentionally tiny. Channel/provider helpers belong on
// dedicated subpaths or, for legacy consumers, the compat surface.

export type {
  ChannelAccountSnapshot,
  ChannelAgentTool,
  ChannelAgentToolFactory,
  ChannelCapabilities,
  ChannelGatewayContext,
  ChannelId,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "../channels/plugins/types.js";
export type {
  ChannelConfiguredBindingConversationRef,
  ChannelConfiguredBindingMatch,
  ChannelConfiguredBindingProvider,
} from "../channels/plugins/types.adapters.js";
export type { ChannelConfigSchema, ChannelPlugin } from "../channels/plugins/types.plugin.js";
export type { ChannelSetupAdapter, ChannelSetupInput } from "../channels/plugins/types.js";
export type {
  ConfiguredBindingConversation,
  ConfiguredBindingResolution,
  CompiledConfiguredBinding,
  StatefulBindingTargetDescriptor,
} from "../channels/plugins/binding-types.js";
export type {
  StatefulBindingTargetDriver,
  StatefulBindingTargetReadyResult,
  StatefulBindingTargetResetResult,
  StatefulBindingTargetSessionResult,
} from "../channels/plugins/stateful-target-drivers.js";
export type {
  ChannelSetupWizard,
  ChannelSetupWizardAllowFromEntry,
} from "../channels/plugins/setup-wizard.js";
export type {
  AnyAgentTool,
  MediaUnderstandingProviderPlugin,
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  PluginLogger,
  ProviderAuthContext,
  ProviderAuthResult,
  ProviderRuntimeModel,
  SpeechProviderPlugin,
} from "../plugins/types.js";
export type {
  PluginRuntime,
  RuntimeLogger,
  SubagentRunParams,
  SubagentRunResult,
} from "../plugins/runtime/types.js";
export type { OpenClawConfig } from "../config/config.js";
/** @deprecated Use OpenClawConfig instead */
export type { OpenClawConfig as ClawdbotConfig } from "../config/config.js";
export * from "./image-generation.js";
export type { SecretInput, SecretRef } from "../config/types.secrets.js";
export type { RuntimeEnv } from "../runtime.js";
export type { HookEntry } from "../hooks/types.js";
export type { ReplyPayload } from "../auto-reply/types.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export type { ContextEngineFactory } from "../context-engine/registry.js";

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { registerContextEngine } from "../context-engine/registry.js";
export { delegateCompactionToRuntime } from "../context-engine/delegate.js";

// Channel config helpers (used by zoom + other channel extensions)
export {
  normalizeChannelSlug,
  buildChannelKeyCandidates,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "../channels/channel-config.js";
export { resolveToolsBySender } from "../config/group-policy.js";
export type { AllowlistMatch } from "../channels/allowlist-match.js";
export type { ChannelGroupContext } from "../channels/plugins/types.core.js";
export type { GroupPolicy } from "../config/types.base.js";
export type { GroupToolPolicyConfig } from "../config/types.tools.js";
