import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  tesseractToolCall,
  tesseractFetch,
  setActiveUser,
  getActiveUser,
  getSessionInfo,
  listSessions,
  clearAllSessions,
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

// ETL Bot uses the PulseBot model: all behavioral rules live in tool descriptions.
// No prompt injection, no separate agent session. Activation adds a binding that
// gates tool visibility and changes the speaker name to "ETL Bot says:".

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
    // ETL MODE ACTIVATION TOOLS — available to ALL agents (cwbot)
    // Activation adds a binding to openclaw.json which:
    //   1. Makes ETL tools visible (isEtlBoundChannel gate)
    //   2. Changes speaker name to "ETL Bot says:" (resolveAgentSpeakerName)
    // =====================================================================

    api.registerTool((ctx) => {
      // Hide activation/deactivation from web frontend — ETL tools are always available there
      if (ctx.sessionKey?.includes("tesseract-web-")) return null;
      return ({
        name: "tesseract_activate_etl_mode",
        description:
          "Activate ETL Bot mode for the current Zoom channel. " +
          "This enables full access to Tesseract platform migration tools. " +
          "The user must explicitly request activation. Only works in Zoom group channels.\n" +
          "After activation, the first thing to do is check connection status with " +
          "tesseract_who_am_i and guide the user through sign-in if not connected.",
        parameters: Type.Object({}),
        async execute() {
          const sessionKey = ctx.sessionKey;
          if (!sessionKey || REJECT_SESSION_KEYS.has(sessionKey)) {
            return errorResult(new Error("Cannot identify this channel — no valid session key."));
          }
          const jid = extractZoomChannelJid(sessionKey);
          if (!jid) {
            return errorResult(new Error(
              "ETL Bot activation is only supported in Zoom group channels. " +
              `Session key format not recognized: ${sessionKey}`
            ));
          }
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
                if (existing.agentId === "etl-bot") {
                  alreadyBound = true;
                  return;
                }
                existing.agentId = "etl-bot";
              } else {
                bindings.push({
                  agentId: "etl-bot",
                  match: { channel: "zoom", peer: { kind: "channel", id: jid } },
                });
              }
            });
            if (alreadyBound) {
              return jsonResult({ ok: true, message: "ETL Bot mode is already active in this channel." });
            }
            return jsonResult({
              ok: true,
              message: "ETL Bot mode activated! From the next message onward, this channel will " +
                "show 'ETL Bot says:' with full access to Tesseract ETL tools. " +
                "Say 'deactivate ETL mode' to switch back to cwbot.",
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      });
    });

    api.registerTool((ctx) => {
      if (ctx.sessionKey?.includes("tesseract-web-")) return null;
      return ({
        name: "tesseract_deactivate_etl_mode",
        description:
          "Deactivate ETL Bot mode for the current Zoom channel, " +
          "reverting to the default cwbot agent. The user must explicitly request this.",
        parameters: Type.Object({}),
        async execute() {
          const sessionKey = ctx.sessionKey;
          if (!sessionKey || REJECT_SESSION_KEYS.has(sessionKey)) {
            return errorResult(new Error("Cannot identify this channel — no valid session key."));
          }
          const jid = extractZoomChannelJid(sessionKey);
          if (!jid) {
            return errorResult(new Error(`Session key format not recognized: ${sessionKey}`));
          }
          try {
            let wasRemoved = false;
            modifyConfig((config) => {
              const bindings = (config.bindings as Array<Record<string, unknown>>) || [];
              const idx = bindings.findIndex((b) => {
                const match = b.match as Record<string, unknown> | undefined;
                const peer = match?.peer as Record<string, unknown> | undefined;
                return match?.channel === "zoom" && peer?.id === jid && b.agentId === "etl-bot";
              });
              if (idx !== -1) {
                bindings.splice(idx, 1);
                wasRemoved = true;
              }
              config.bindings = bindings;
            });
            if (!wasRemoved) {
              return jsonResult({ ok: true, message: "ETL Bot mode is not active in this channel. No changes made." });
            }
            return jsonResult({ ok: true, message: "ETL Bot mode deactivated. This channel is back to cwbot." });
          } catch (err) {
            return errorResult(err);
          }
        },
      });
    });

    // =====================================================================
    // ETL TOOLS — only visible in channels bound to etl-bot
    // =====================================================================

    /**
     * Should ETL tools be visible for this session?
     * - Tesseract web frontend: ALWAYS (it's our own UI)
     * - Zoom channels: only when bound to etl-bot via openclaw.json
     */
    function shouldShowEtlTools(sessionKey: string | undefined): boolean {
      if (!sessionKey) return false;

      // Tesseract web frontend always gets ETL tools.
      // Session key format: "agent:main:tesseract-web-{email}" or "tesseract-web-{email}"
      if (sessionKey.includes("tesseract-web-")) {
        console.log(`[tesseract] shouldShowEtlTools: web frontend detected, sessionKey="${sessionKey}"`);
        return true;
      }

      // Zoom channels: check for etl-bot binding in config
      const jid = extractZoomChannelJid(sessionKey);
      if (!jid) {
        console.log(`[tesseract] shouldShowEtlTools: no match, sessionKey="${sessionKey}"`);
        return false;
      }
      try {
        const fs = require("node:fs") as typeof import("node:fs");
        const configDir = process.env.OPENCLAW_STATE_DIR
          || (process.env.HOME ? `${process.env.HOME}/.openclaw` : "/home/node/.openclaw");
        const freshCfg = JSON.parse(fs.readFileSync(`${configDir}/openclaw.json`, "utf-8"));
        const bindings = Array.isArray(freshCfg.bindings) ? freshCfg.bindings : [];
        return bindings.some((b: Record<string, unknown>) => {
          const match = b?.match as Record<string, unknown> | undefined;
          const peer = match?.peer as Record<string, unknown> | undefined;
          return match?.channel === "zoom"
            && peer?.kind === "channel"
            && peer?.id === jid
            && b?.agentId === "etl-bot";
        });
      } catch {
        return false;
      }
    }

    /** Register an ETL tool — visible in web frontend always, Zoom only when ETL-bound. */
    const registerEtlTool: typeof api.registerTool = (factory, opts) => {
      api.registerTool((ctx) => {
        if (!shouldShowEtlTools(ctx.sessionKey)) return null;
        return typeof factory === "function" ? factory(ctx) : factory;
      }, opts);
    };

    // --- Generic Platform Tools ---

    registerEtlTool((ctx) => ({
      name: "tesseract_call_platform_api",
      description:
        "Make an API request to any platform gateway. Auth is automatic once connected. " +
        "Use tesseract_search_endpoints FIRST if you don't know the exact path.\n" +
        "PLATFORM NOTES:\n" +
        "- Zoom: POST /phone/users is DEPRECATED (405). Use PATCH /users/{email}/settings " +
        "with {\"feature\":{\"zoom_phone\":true}} to enable Zoom Phone. Type 3010 = ZP Basic.\n" +
        "- Zoom IVR: NEVER use this tool for IVR key presses — use tesseract_configure_zoom_ar_ivr instead.\n" +
        "- RingCentral: NEVER use /restapi/v1.0/ paths (404). Use gateway routes. " +
        "v1.0 answering-rules disabled (CMN-468) — use v2 comm-handling.\n" +
        "- Teams: No 'sites' concept. Auto attendants use different IVR action types.\n" +
        "When asked about a specific platform, ONLY check that platform. " +
        "Do NOT mention other platforms unless the user says 'migrate'.",
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
        "descriptions, and body format hints. ALWAYS call this BEFORE tesseract_call_platform_api " +
        "when you don't know the exact path. Auth is automatic once connected.",
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
        "MUST be called FIRST when a user asks to migrate. The guide contains step-by-step " +
        "instructions — these are COMMANDS, not suggestions.\n" +
        "MIGRATION RULES:\n" +
        "- After loading the guide, your VERY NEXT ACTION must be tool calls to gather data — NOT text.\n" +
        "- Steps are numbered. Complete them IN ORDER. Do NOT skip, combine, or reorder.\n" +
        "- After each step, state which step you finished and which is next.\n" +
        "- When a step says execute immediately, do it — don't ask permission.\n" +
        "- Present decisions ONE question at a time. Wait for answer. Give recommendation.\n" +
        "- NEVER say 'I will fetch details later' — gather data NOW.\n" +
        "- NEVER say 'this will need manual configuration' — try API first.\n" +
        "- NEVER use tesseract_query_etl during a migration (it queries internal DB, not live platform data).\n" +
        "- Report results with checkmarks as you execute.",
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
        "ALWAYS use this tool for IVR config — NEVER use tesseract_call_platform_api for IVR.\n" +
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
        "Query the internal Tesseract ETL database. This queries INTERNAL data " +
        "(job types, extractors, loaders, field mappings, etc.) — NOT live platform data.\n" +
        "WARNING: NEVER use this during a migration workflow. To get data from platforms, " +
        "ALWAYS use tesseract_call_platform_api or tesseract_get_platform_users instead.",
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
      description:
        "Check if a platform gateway is healthy. " +
        "Only call when the user explicitly asks about health or status. " +
        "Do NOT call proactively.",
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
        "NEVER ask for passwords in chat — always use this tool instead.\n" +
        "After calling: paste the FULL URL into your reply so the user can click it. " +
        "Then poll tesseract_check_signin until verified=true, then call tesseract_connect_as.",
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
        "Check if a user completed sign-in verification. Poll this until verified=true. " +
        "Once verified, call tesseract_connect_as with the email to activate the session.",
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
        "NEVER call without first verifying identity via tesseract_request_signin + tesseract_check_signin. " +
        "Anyone can claim any email — the sign-in link proves they know the password.\n" +
        "Pass empty email to disconnect. Session expires after 24h of inactivity.",
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
        "Check connection status for this channel. " +
        "IMPORTANT: Call this FIRST when ETL tools become available (after activation). " +
        "If not connected, guide the user through sign-in:\n" +
        "1. Ask if they have an existing Tesseract account\n" +
        "2. If yes: ask for their email, then call tesseract_request_signin\n" +
        "3. Share the sign-in URL with them (tell them to click it)\n" +
        "4. Poll tesseract_check_signin until verified=true\n" +
        "5. Call tesseract_connect_as with the verified email\n" +
        "If new user: direct them to the Tesseract web app to create an account first.\n" +
        "NEVER ask for passwords in chat — always use secure sign-in links.",
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
      description:
        "List all active sessions across all channels. " +
        "Each channel has its own independent session — sessions are NEVER shared across channels.",
      parameters: Type.Object({}),
      async execute() {
        const sessions = listSessions();
        return jsonResult({ active_sessions: sessions.length, sessions });
      },
    }));

    // --- Onboarding Tools ---

    registerEtlTool(() => ({
      name: "tesseract_onboard_company",
      description:
        "Create a new Tesseract user account for a company. " +
        "Prefer directing new users to the Tesseract web app instead. " +
        "Only use this if the web app is unavailable.",
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
        "NEVER ask for credentials or secrets in chat — always use this secure link. " +
        "Share the full URL so the user can click it.",
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

    console.log("[tesseract] Registered 2 activation tools + 22 ETL tools (all agents)");
  },
};

export default plugin;
