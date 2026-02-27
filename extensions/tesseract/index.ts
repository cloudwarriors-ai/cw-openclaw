import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import {
  tesseractToolCall,
  tesseractFetch,
  setActiveUser,
  getActiveUser,
  getSessionInfo,
  listSessions,
  externalizeUrl,
} from "./tesseract-auth.js";

// --- Config file management for dynamic agent bindings ---

const CONFIG_DIR = process.env.OPENCLAW_STATE_DIR
  || (process.env.HOME
    ? path.join(process.env.HOME, ".openclaw")
    : "/home/node/.openclaw");
const CONFIG_PATH = path.join(CONFIG_DIR, "openclaw.json");

/**
 * Extract the Zoom channel JID from a session key.
 * Handles formats: "agent:{id}:zoom:channel:{jid}" and "zoom-channel-{jid}"
 */
function extractZoomChannelJid(sessionKey: string): string | null {
  const match = sessionKey.match(/^agent:[^:]+:zoom:channel:(.+)$/);
  if (match) return match[1];
  const simpleMatch = sessionKey.match(/^zoom-channel-(.+)$/);
  if (simpleMatch) return simpleMatch[1];
  return null;
}

/**
 * Read, modify, and write openclaw.json atomically.
 * The chokidar watcher in the gateway detects the change and reloads config.
 */
function modifyConfig(modifier: (config: Record<string, unknown>) => void): void {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw) as Record<string, unknown>;
  modifier(config);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Inject a synthetic message into cwbot's session transcript for a channel.
 * This tells cwbot that ETL mode was deactivated, preventing stale context
 * from making cwbot think ETL mode is still active.
 */
function injectDeactivationIntoSession(jid: string): void {
  const SESSIONS_DIR = path.join(CONFIG_DIR, "agents", "main", "sessions");
  const SESSIONS_JSON = path.join(SESSIONS_DIR, "sessions.json");
  const sessionKey = `agent:main:zoom:channel:${jid}`;

  try {
    console.log(`[tesseract] injectDeactivation: looking up session for key=${sessionKey}`);
    const raw = fs.readFileSync(SESSIONS_JSON, "utf-8");
    const sessions = JSON.parse(raw) as Record<string, { sessionId?: string; sessionFile?: string }>;
    const entry = sessions[sessionKey];
    if (!entry?.sessionFile) {
      console.log(`[tesseract] injectDeactivation: no sessionFile found for key`);
      return;
    }

    const transcriptPath = entry.sessionFile;
    console.log(`[tesseract] injectDeactivation: transcriptPath=${transcriptPath} exists=${fs.existsSync(transcriptPath)}`);
    if (!fs.existsSync(transcriptPath)) return;

    const now = new Date().toISOString();
    const userMsgId = crypto.randomBytes(4).toString("hex");
    const asstMsgId = crypto.randomBytes(4).toString("hex");

    // Read last message to get its ID for parentId chaining
    const content = fs.readFileSync(transcriptPath, "utf-8").trimEnd();
    const lines = content.split("\n");
    let lastId: string | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.id) { lastId = obj.id; break; }
      } catch { /* skip malformed lines */ }
    }

    console.log(`[tesseract] injectDeactivation: lastId=${lastId} lineCount=${lines.length}`);

    // Append a synthetic user notification + assistant acknowledgment
    const userMsg = {
      type: "message",
      id: userMsgId,
      parentId: lastId ?? null,
      timestamp: now,
      message: {
        role: "user",
        content: [{
          type: "text",
          text: "[System notification] ETL Bot mode has been deactivated for this channel. " +
            "You are cwbot again — the general-purpose assistant. All ETL tools and context " +
            "from the ETL Bot session are no longer relevant. Do not reference ETL mode, " +
            "do not say 'ETL Bot says:', and do not offer to reactivate unless the user asks.",
        }],
      },
    };
    const asstMsg = {
      type: "message",
      id: asstMsgId,
      parentId: userMsgId,
      timestamp: now,
      message: {
        role: "assistant",
        content: [{
          type: "text",
          text: "Understood. ETL Bot mode has been deactivated. I'm cwbot, the general-purpose assistant. How can I help?",
        }],
      },
    };

    const payload = "\n" + JSON.stringify(userMsg) + "\n" + JSON.stringify(asstMsg);
    fs.appendFileSync(transcriptPath, payload);
    console.log(`[tesseract] injectDeactivation: appended ${payload.length} bytes to ${transcriptPath}`);
  } catch (err) {
    console.log(`[tesseract] injectDeactivation: ERROR ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Zoom conversation store (read-only) ---

const ZOOM_CONVERSATIONS_PATH = path.join(CONFIG_DIR, "zoom-conversations.json");

interface ZoomConversationEntry {
  channelJid?: string;
  channelName?: string;
  conversationType?: string;
  robotJid?: string;
  accountId?: string;
  lastSeenAt?: string;
}

/**
 * Read the Zoom conversation store and return channel entries (name + JID).
 */
function getKnownZoomChannels(): Array<{ jid: string; name: string; accountId?: string; lastSeenAt?: string }> {
  try {
    const raw = fs.readFileSync(ZOOM_CONVERSATIONS_PATH, "utf-8");
    const store = JSON.parse(raw) as { conversations?: Record<string, ZoomConversationEntry> };
    const convos = store.conversations || {};
    return Object.values(convos)
      .filter((e) => e.conversationType === "channel" && e.channelJid && e.channelName)
      .map((e) => ({
        jid: e.channelJid!,
        name: e.channelName!,
        accountId: e.accountId,
        lastSeenAt: e.lastSeenAt,
      }));
  } catch {
    return [];
  }
}

/**
 * Resolve a channel name or JID to a JID. Checks the conversation store for name matches.
 * When multiple channels share the same name (from different accounts), picks the most recent.
 */
function resolveChannelJid(input: string): { jid: string; name?: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Already a JID
  if (trimmed.includes("@conference.")) return { jid: trimmed };
  // Look up by name (case-insensitive), sort by most recently seen
  const channels = getKnownZoomChannels()
    .sort((a, b) => (b.lastSeenAt || "").localeCompare(a.lastSeenAt || ""));
  const lower = trimmed.toLowerCase();
  // Deduplicate by JID (same channel seen by multiple bot installations)
  const seen = new Set<string>();
  const deduped = channels.filter((c) => {
    if (seen.has(c.jid)) return false;
    seen.add(c.jid);
    return true;
  });
  // Exact match (most recent wins)
  const exact = deduped.find((c) => c.name.toLowerCase() === lower);
  if (exact) return { jid: exact.jid, name: exact.name };
  // Partial match — only if unambiguous
  const partial = deduped.filter((c) => c.name.toLowerCase().includes(lower));
  if (partial.length === 1) return { jid: partial[0].jid, name: partial[0].name };
  return null;
}

// --- Helpers ---

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }] };
}

const REJECT_SESSION_KEYS = new Set(["unknown", "_default", "global", ""]);

/**
 * Resolve the channel identifier for session isolation.
 * ALWAYS uses the framework-provided sessionKey as the authoritative channel.
 */
function resolveChannel(_explicitChannel?: string, sessionKey?: string): string | undefined {
  const raw = sessionKey?.trim() || undefined;
  if (!raw || REJECT_SESSION_KEYS.has(raw)) return undefined;
  return raw;
}

/**
 * Guard: require a user to be connected in this channel before platform operations.
 * Web frontend users are auto-connected — their email is in the session key.
 */
function requireConnectedUser(channel?: string) {
  let user = getActiveUser(channel);
  if (!user && channel) {
    // Web frontend auto-connect: session key contains "tesseract-web-{email}"
    const webMatch = channel.match(/tesseract-web-(.+@[^:]+)/);
    if (webMatch) {
      const email = webMatch[1];
      setActiveUser(email, channel);
      user = email;
    }
  }
  if (!user) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          error: "No user connected in this channel. The user must sign in first. " +
            "Ask them: 'Do you have an existing Tesseract account, or do you need to set one up?' " +
            "Then use tesseract_request_signin + tesseract_check_signin + tesseract_connect_as for sign-in.",
        }),
      }],
    };
  }
  return null;
}

// --- Plugin ---

const plugin = {
  id: "tesseract",
  name: "Tesseract ETL Platform",
  description:
    "AI-powered ETL platform for migrating phone system configurations between " +
    "cloud platforms (Teams, RingCentral, Zoom, GoTo, Dialpad). Provides tools for " +
    "platform API operations, migration workflows, and ETL management.",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // =====================================================================
    // ETL CHANNEL BINDING — cwbot only (sole binding controller)
    // Called from DM to bind a Zoom channel to etl-bot.
    // =====================================================================

    api.registerTool((ctx) => {
      if (ctx.agentId === "etl-bot") return null;
      if (ctx.sessionKey?.includes("tesseract-web-")) return null;
      return ({
        name: "tesseract_bind_etl_channel",
        description:
          "Bind a Zoom channel to the ETL Bot agent. All future messages in that " +
          "channel will route to the ETL Bot with its own isolated session. " +
          "Accepts a channel name (looked up from known channels) or a full JID.",
        parameters: Type.Object({
          channel: Type.String({
            description: "Channel name (e.g., 'CcompanyETL') or full JID (e.g., abc123@conference.xmpp.zoom.us)"
          }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const input = (params.channel as string || "").trim();
          if (!input) {
            return errorResult(new Error("channel is required. Provide a channel name or JID."));
          }
          const resolved = resolveChannelJid(input);
          if (!resolved) {
            const known = getKnownZoomChannels().map((c) => c.name);
            return errorResult(new Error(
              `Could not find a channel matching "${input}". ` +
              (known.length > 0
                ? `Known channels: ${known.join(", ")}`
                : "No known channels found. The bot must be added to the channel first.")
            ));
          }
          const jid = resolved.jid;
          try {
            let alreadyBound = false;
            modifyConfig((config) => {
              const bindings = (config.bindings as Array<Record<string, unknown>>) || [];
              config.bindings = bindings;
              const existing = bindings.find((b) => {
                const match = b.match as Record<string, unknown> | undefined;
                const peer = match?.peer as Record<string, unknown> | undefined;
                return match?.channel === "zoom" && peer?.id === jid;
              });
              if (existing) {
                if (existing.agentId === "etl-bot") { alreadyBound = true; return; }
                existing.agentId = "etl-bot";
              } else {
                bindings.push({
                  agentId: "etl-bot",
                  match: { channel: "zoom", peer: { kind: "channel", id: jid } },
                });
              }
            });
            if (alreadyBound) {
              return jsonResult({ ok: true, message: `That channel is already bound to ETL Bot.`, channel_name: resolved.name, bound_jid: jid });
            }
            return jsonResult({
              ok: true,
              message: `Channel "${resolved.name || jid}" bound to ETL Bot. All messages in that channel will now route to the ETL Bot agent with its own session.`,
              channel_name: resolved.name,
              bound_jid: jid,
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      });
    });

    // =====================================================================
    // ETL CHANNEL UNBINDING — cwbot only (sole binding controller)
    // Called from DM to remove etl-bot binding from a channel.
    // =====================================================================

    api.registerTool((ctx) => {
      if (ctx.agentId === "etl-bot") return null;
      if (ctx.sessionKey?.includes("tesseract-web-")) return null;
      return ({
        name: "tesseract_unbind_etl_channel",
        description:
          "Remove the ETL Bot binding from a Zoom channel. " +
          "Accepts a channel name or JID. Messages will revert to the default agent (cwbot).",
        parameters: Type.Object({
          channel: Type.String({
            description: "Channel name (e.g., 'CcompanyETL') or full JID to unbind"
          }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const input = (params.channel as string || "").trim();
          if (!input) return errorResult(new Error("channel is required. Provide a channel name or JID."));
          const resolved = resolveChannelJid(input);
          if (!resolved) {
            const known = getKnownZoomChannels().map((c) => c.name);
            return errorResult(new Error(
              `Could not find a channel matching "${input}". ` +
              (known.length > 0
                ? `Known channels: ${known.join(", ")}`
                : "No known channels found.")
            ));
          }
          const jid = resolved.jid;
          try {
            let wasRemoved = false;
            modifyConfig((config) => {
              const bindings = (config.bindings as Array<Record<string, unknown>>) || [];
              const idx = bindings.findIndex((b) => {
                const match = b.match as Record<string, unknown> | undefined;
                const peer = match?.peer as Record<string, unknown> | undefined;
                return match?.channel === "zoom" && peer?.id === jid && b.agentId === "etl-bot";
              });
              if (idx !== -1) { bindings.splice(idx, 1); wasRemoved = true; }
              config.bindings = bindings;
            });
            if (!wasRemoved) {
              return jsonResult({ ok: true, message: "No ETL Bot binding found for that channel." });
            }
            injectDeactivationIntoSession(jid);
            return jsonResult({ ok: true, message: `ETL Bot unbound from "${resolved.name || jid}". Channel reverts to cwbot.` });
          } catch (err) {
            return errorResult(err);
          }
        },
      });
    });

    // =====================================================================
    // LIST ETL BINDINGS — cwbot only
    // =====================================================================

    api.registerTool((ctx) => {
      if (ctx.agentId === "etl-bot") return null;
      if (ctx.sessionKey?.includes("tesseract-web-")) return null;
      return ({
        name: "tesseract_list_etl_bindings",
        description: "List all Zoom channels currently bound to the ETL Bot agent.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
            const config = JSON.parse(raw);
            const bindings = (config.bindings || []) as Array<Record<string, unknown>>;
            const knownChannels = getKnownZoomChannels();
            const etlBindings = bindings
              .filter((b) => b.agentId === "etl-bot")
              .map((b) => {
                const match = b.match as Record<string, unknown>;
                const peer = match?.peer as Record<string, unknown>;
                const jid = peer?.id as string | undefined;
                const known = jid ? knownChannels.find((c) => c.jid === jid) : undefined;
                return { channel_jid: jid, channel_name: known?.name, channel: match?.channel };
              });
            return jsonResult({ ok: true, bindings: etlBindings, count: etlBindings.length });
          } catch (err) {
            return errorResult(err);
          }
        },
      });
    });

    // =====================================================================
    // LIST BOT CHANNELS — cwbot only
    // Shows all Zoom channels the bot knows about (for name→JID lookup).
    // =====================================================================

    api.registerTool((ctx) => {
      if (ctx.agentId === "etl-bot") return null;
      if (ctx.sessionKey?.includes("tesseract-web-")) return null;
      return ({
        name: "tesseract_list_bot_channels",
        description:
          "List all Zoom channels the bot has been added to. " +
          "Returns channel names and JIDs. Use this to find the right channel " +
          "before calling tesseract_bind_etl_channel.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const channels = getKnownZoomChannels();
            return jsonResult({
              ok: true,
              channels: channels.map((c) => ({ name: c.name, jid: c.jid })),
              count: channels.length,
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      });
    });

    // =====================================================================
    // ETL TOOLS — visible to etl-bot agent and Tesseract web frontend
    // =====================================================================

    /**
     * Should ETL tools be visible for this context?
     * - Tesseract web frontend: always (it's our own UI)
     * - Zoom channels: only when the current agent is etl-bot
     */
    function shouldShowEtlTools(ctx: { sessionKey?: string; agentId?: string }): boolean {
      if (ctx.sessionKey?.includes("tesseract-web-")) return true;
      return ctx.agentId === "etl-bot";
    }

    /** Register an ETL tool — visible to etl-bot agent and web frontend. */
    const registerEtlTool: typeof api.registerTool = (factory, opts) => {
      api.registerTool((ctx) => {
        if (!shouldShowEtlTools(ctx)) return null;
        return typeof factory === "function" ? factory(ctx) : factory;
      }, opts);
    };

    // --- Generic Platform Tools ---

    registerEtlTool((ctx) => ({
      name: "tesseract_call_platform_api",
      description:
        "Make an API request to any platform gateway. Auth is automatic once connected. " +
        "Use tesseract_search_endpoints first if you don't know the exact path.\n" +
        "Platform notes: Zoom POST /phone/users is deprecated (405) — use PATCH /users/{email}/settings. " +
        "Zoom IVR — use tesseract_configure_zoom_ar_ivr instead. " +
        "RingCentral v1.0 answering-rules disabled (CMN-468) — use v2 comm-handling.",
      parameters: Type.Object({
        platform: Type.String({ description: "Platform: zoom, ringcentral, teams, goto, or dialpad" }),
        method: Type.String({ description: "HTTP method: GET, POST, PUT, PATCH, or DELETE" }),
        path: Type.String({ description: "API path (e.g., /api/phone/users, /extensions, /callqueues)" }),
        params: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Query parameters" })),
        body: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Request body for POST/PUT/PATCH" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const ch = resolveChannel(undefined, ctx.sessionKey);
        const guard = requireConnectedUser(ch);
        if (guard) return guard;
        try {
          const { channel: _, ...args } = params;
          const result = await tesseractToolCall("call_platform_api", args, ch);
          return jsonResult(result);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool((ctx) => ({
      name: "tesseract_search_endpoints",
      description:
        "Search available API endpoints for a platform. Returns paths, methods, " +
        "descriptions, and body format hints. Call before tesseract_call_platform_api " +
        "when you don't know the exact path.",
      parameters: Type.Object({
        platform: Type.String({ description: "Platform: zoom, ringcentral, teams, goto, or dialpad" }),
        query: Type.String({ description: "Search term (e.g., 'call queues', 'users', 'phone numbers')" }),
        method: Type.Optional(Type.String({ description: "Filter by HTTP method" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const ch = resolveChannel(undefined, ctx.sessionKey);
        const guard = requireConnectedUser(ch);
        if (guard) return guard;
        try {
          const { channel: _, ...args } = params;
          const result = await tesseractToolCall("search_endpoints", args, ch);
          return jsonResult(result);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool((ctx) => ({
      name: "tesseract_get_platform_users",
      description:
        "Get ALL users/extensions from a platform with automatic pagination. " +
        "Use for counting users or finding a specific person.",
      parameters: Type.Object({
        platform: Type.String({ description: "Platform: zoom, ringcentral, teams, goto, or dialpad" }),
        search: Type.Optional(Type.String({ description: "Filter by name or email" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const ch = resolveChannel(undefined, ctx.sessionKey);
        const guard = requireConnectedUser(ch);
        if (guard) return guard;
        try {
          const { channel: _, ...args } = params;
          const result = await tesseractToolCall("get_platform_users", args, ch);
          return jsonResult(result);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool((ctx) => ({
      name: "tesseract_get_migration_guide",
      description:
        "Load the migration guide for a source->target platform pair. " +
        "Contains step-by-step instructions for the migration workflow.",
      parameters: Type.Object({
        source: Type.String({ description: "Source platform: zoom, ringcentral, teams, goto, or dialpad" }),
        target: Type.String({ description: "Target platform: zoom, ringcentral, teams, goto, or dialpad" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const ch = resolveChannel(undefined, ctx.sessionKey);
        const guard = requireConnectedUser(ch);
        if (guard) return guard;
        try {
          const { channel: _, ...args } = params;
          const result = await tesseractToolCall("get_migration_guide", args, ch);
          return jsonResult(result);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // --- Zoom-Specific Tools ---

    registerEtlTool((ctx) => ({
      name: "tesseract_create_zoom_user",
      description:
        "Create a new Zoom account user. Must be done BEFORE enabling Zoom Phone. " +
        "Type 1 = Basic (free, default), Type 2 = Licensed.",
      parameters: Type.Object({
        email: Type.String({ description: "User email address" }),
        first_name: Type.String({ description: "First name" }),
        last_name: Type.String({ description: "Last name" }),
        type: Type.Optional(Type.Number({ description: "1=Basic (free, default), 2=Licensed" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const ch = resolveChannel(undefined, ctx.sessionKey);
        const guard = requireConnectedUser(ch);
        if (guard) return guard;
        try {
          const { channel: _, ...args } = params;
          const result = await tesseractToolCall("create_zoom_user", args, ch);
          return jsonResult(result);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool((ctx) => ({
      name: "tesseract_enable_zoom_phone",
      description:
        "Enable or disable Zoom Phone for an existing Zoom user. " +
        "This uses PATCH /users/{email}/settings internally (the correct approach). " +
        "NEVER use tesseract_call_platform_api with POST /phone/users — it's deprecated (405).",
      parameters: Type.Object({
        email: Type.String({ description: "User email address" }),
        enabled: Type.Boolean({ description: "true to enable, false to disable" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const ch = resolveChannel(undefined, ctx.sessionKey);
        const guard = requireConnectedUser(ch);
        if (guard) return guard;
        try {
          const { channel: _, ...args } = params;
          const result = await tesseractToolCall("enable_zoom_phone", args, ch);
          return jsonResult(result);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool((ctx) => ({
      name: "tesseract_create_zoom_site",
      description: "Create a Zoom Phone site with emergency address.",
      parameters: Type.Object({
        name: Type.String({ description: "Site name" }),
        address_line1: Type.String({ description: "Street address" }),
        city: Type.String({ description: "City" }),
        state_code: Type.String({ description: "State code (e.g., CA, NY)" }),
        zip: Type.String({ description: "ZIP/postal code" }),
        address_line2: Type.Optional(Type.String({ description: "Address line 2" })),
        country_code: Type.Optional(Type.String({ description: "Country code (default: US)" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const ch = resolveChannel(undefined, ctx.sessionKey);
        const guard = requireConnectedUser(ch);
        if (guard) return guard;
        try {
          const { channel: _, ...args } = params;
          const result = await tesseractToolCall("create_zoom_site", args, ch);
          return jsonResult(result);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool((ctx) => ({
      name: "tesseract_create_zoom_call_queue",
      description:
        "Create a Zoom call queue. Auto-generates extension number starting from 5001. " +
        "Requires extension_number in body (handled automatically by this tool).",
      parameters: Type.Object({
        name: Type.String({ description: "Call queue name" }),
        site_id: Type.Optional(Type.String({ description: "Site ID (uses default site if omitted)" })),
        description: Type.Optional(Type.String({ description: "Queue description" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const ch = resolveChannel(undefined, ctx.sessionKey);
        const guard = requireConnectedUser(ch);
        if (guard) return guard;
        try {
          const { channel: _, ...args } = params;
          const result = await tesseractToolCall("create_zoom_call_queue", args, ch);
          return jsonResult(result);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool((ctx) => ({
      name: "tesseract_add_user_to_zoom_queue",
      description: "Add a user to a Zoom call queue.",
      parameters: Type.Object({
        queue_id: Type.String({ description: "Call queue ID" }),
        email: Type.String({ description: "User email to add" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const ch = resolveChannel(undefined, ctx.sessionKey);
        const guard = requireConnectedUser(ch);
        if (guard) return guard;
        try {
          const { channel: _, ...args } = params;
          const result = await tesseractToolCall("add_user_to_zoom_queue", args, ch);
          return jsonResult(result);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool((ctx) => ({
      name: "tesseract_configure_zoom_ar_ivr",
      description:
        "Configure IVR key presses on a Zoom Auto Receptionist. " +
        "Action codes: 100=connect to extension, 10=voicemail, 21=repeat menu, " +
        "-1=disconnect, 7=dial by name.",
      parameters: Type.Object({
        ar_id: Type.String({ description: "Auto Receptionist ID" }),
        key_actions: Type.Object({}, {
          additionalProperties: true,
          description: "Key-to-action mapping",
        }),
        no_input_action: Type.Optional(Type.Object({}, {
          additionalProperties: true,
          description: "Action when no key is pressed",
        })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const ch = resolveChannel(undefined, ctx.sessionKey);
        const guard = requireConnectedUser(ch);
        if (guard) return guard;
        try {
          const { channel: _, ...args } = params;
          const result = await tesseractToolCall("configure_zoom_ar_ivr", args, ch);
          return jsonResult(result);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // --- ETL & Admin Tools ---

    registerEtlTool(() => ({
      name: "tesseract_query_etl",
      description:
        "Query the internal Tesseract ETL database (job types, extractors, loaders, " +
        "field mappings, etc.). This queries internal data, not live platform APIs.",
      parameters: Type.Object({
        resource: Type.String({
          description: "Resource type: platforms, job_types, jobs, job_status, job_groups, extractors, loaders, data_records, field_mappings",
        }),
        id: Type.Optional(Type.Number({ description: "Specific resource ID" })),
        filters: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Filter parameters" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const result = await tesseractToolCall("query_etl", params);
          return jsonResult(result);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool(() => ({
      name: "tesseract_check_health",
      description: "Check if a platform gateway is healthy.",
      parameters: Type.Object({
        platform: Type.String({ description: "Platform: zoom, ringcentral, teams, goto, or dialpad" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const result = await tesseractToolCall("check_health", params);
          return jsonResult(result);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // --- Authentication / Session Tools ---

    registerEtlTool(() => ({
      name: "tesseract_request_signin",
      description:
        "Generate a secure one-time sign-in link for user identity verification. " +
        "Returns a URL to share with the user. Poll tesseract_check_signin until " +
        "verified=true, then call tesseract_connect_as.",
      parameters: Type.Object({
        user_email: Type.String({ description: "Email of the Tesseract user" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const resp = await tesseractFetch("/api/chat/signin-link/", {
            method: "POST",
            body: JSON.stringify(params),
          });
          const data = resp.data as Record<string, unknown>;
          if (data && typeof data.url === "string") {
            data.url = externalizeUrl(data.url);
            data._instruction = "IMPORTANT: Paste this URL into your reply so the user can click it.";
            data.signin_url_to_share = data.url;
          }
          return jsonResult(data);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool(() => ({
      name: "tesseract_check_signin",
      description:
        "Check if a user completed sign-in verification. Poll until verified=true, " +
        "then call tesseract_connect_as.",
      parameters: Type.Object({
        token: Type.String({ description: "The token from tesseract_request_signin" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const resp = await tesseractFetch(`/api/chat/signin-status/${params.token}/`);
          return jsonResult(resp.data);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool((ctx) => ({
      name: "tesseract_connect_as",
      description:
        "Activate a verified user's session for this channel. " +
        "Requires prior identity verification via tesseract_request_signin + tesseract_check_signin. " +
        "Pass empty email to disconnect.",
      parameters: Type.Object({
        email: Type.String({ description: "Email of the verified user, or empty to disconnect" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const email = (params.email as string || "").trim();
        const ch = resolveChannel(undefined, ctx.sessionKey);
        if (!ch) {
          return jsonResult({
            ok: false,
            error: "Unable to identify this channel.",
            raw_session_key: ctx.sessionKey ?? "undefined",
          });
        }
        if (!email) {
          setActiveUser(null, ch);
          return jsonResult({ ok: true, message: "Disconnected. Session cleared." });
        }
        setActiveUser(email, ch);
        try {
          const result = await tesseractToolCall("check_health", { platform: "zoom" }, ch);
          return jsonResult({
            ok: true,
            message: `Connected as ${email}. Session expires after 24h of inactivity.`,
            health: result,
          });
        } catch (err) {
          setActiveUser(null, ch);
          return errorResult(new Error(`Failed to connect as ${email}: ${err instanceof Error ? err.message : String(err)}`));
        }
      },
    }));

    registerEtlTool((ctx) => ({
      name: "tesseract_who_am_i",
      description:
        "Check connection status for this channel. Returns the active user email " +
        "or indicates that sign-in is needed.",
      parameters: Type.Object({}),
      async execute() {
        const ch = resolveChannel(undefined, ctx.sessionKey);
        if (!ch) {
          return jsonResult({ connected: false, message: "Unable to identify this channel." });
        }
        // Web frontend auto-connect
        if (!getActiveUser(ch)) {
          const webMatch = ch.match(/tesseract-web-(.+@[^:]+)/);
          if (webMatch) {
            setActiveUser(webMatch[1], ch);
          }
        }
        const info = getSessionInfo(ch);
        if (!info.email) {
          return jsonResult({ connected: false, message: "No user connected. Ask them to sign in." });
        }
        return jsonResult({
          connected: true,
          active_user: info.email,
          inactivity_timeout_hours: info.inactivityTimeoutHours,
          message: `Connected as ${info.email} (expires after ${info.inactivityTimeoutHours}h of inactivity)`,
        });
      },
    }));

    registerEtlTool(() => ({
      name: "tesseract_list_sessions",
      description: "List all active sessions across all channels.",
      parameters: Type.Object({}),
      async execute() {
        const sessions = listSessions();
        return jsonResult({ active_sessions: sessions.length, sessions });
      },
    }));

    // --- Onboarding Tools ---

    registerEtlTool(() => ({
      name: "tesseract_onboard_company",
      description: "Create a new Tesseract user account for a company.",
      parameters: Type.Object({
        email: Type.String({ description: "Email for the new account" }),
        password: Type.String({ description: "Password for the account" }),
        company_name: Type.Optional(Type.String({ description: "Company name" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const resp = await tesseractFetch("/api/chat/onboard/", {
            method: "POST",
            body: JSON.stringify(params),
          });
          return jsonResult(resp.data);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool(() => ({
      name: "tesseract_get_platform_requirements",
      description: "Get required credential fields for a platform.",
      parameters: Type.Object({
        platform: Type.Optional(Type.String({ description: "Platform name" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const qs = params.platform ? `?platform=${params.platform}` : "";
          const resp = await tesseractFetch(`/api/chat/platform-requirements/${qs}`);
          return jsonResult(resp.data);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool(() => ({
      name: "tesseract_setup_platform",
      description: "Set up platform credentials for a user.",
      parameters: Type.Object({
        user_email: Type.String({ description: "Email of the Tesseract user" }),
        platform: Type.String({ description: "Platform: zoom, ringcentral, teams, goto, or dialpad" }),
        credentials: Type.Object({}, { additionalProperties: true, description: "Platform credentials" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const resp = await tesseractFetch("/api/chat/setup-platform/", {
            method: "POST",
            body: JSON.stringify(params),
          });
          return jsonResult(resp.data);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool(() => ({
      name: "tesseract_request_credentials",
      description:
        "Generate a secure link for the user to enter platform credentials privately. " +
        "Returns a URL to share with the user.",
      parameters: Type.Object({
        user_email: Type.String({ description: "Email of the Tesseract user" }),
        platform: Type.String({ description: "Platform: zoom, ringcentral, teams, goto, or dialpad" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const resp = await tesseractFetch("/api/chat/credential-link/", {
            method: "POST",
            body: JSON.stringify(params),
          });
          const data = resp.data as Record<string, unknown>;
          if (data && typeof data.url === "string") {
            data.url = externalizeUrl(data.url);
          }
          return jsonResult(data);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    registerEtlTool(() => ({
      name: "tesseract_check_credential_link",
      description: "Check if a user submitted credentials through a secure link.",
      parameters: Type.Object({
        token: Type.String({ description: "The token from tesseract_request_credentials" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const resp = await tesseractFetch(`/api/chat/credential-status/${params.token}/`);
          return jsonResult(resp.data);
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    console.log("[tesseract] Registered: bind/unbind/list-bindings/list-channels (cwbot), 22 ETL tools (etl-bot + web)");
  },
};

export default plugin;
