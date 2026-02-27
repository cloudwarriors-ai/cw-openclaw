import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const plugin = {
  id: "bighead",
  name: "Bighead",
  description: "Bighead AI avatar integration - send Rebecca to join Zoom meetings (multiworker, user-scoped sessions)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const bigheadUrl = () => process.env.BIGHEAD_API_URL ?? "http://bighead:8000";
    const bigheadToken = () => process.env.BIGHEAD_GATEWAY_TOKEN ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "dev-token";

    // bighead_join_meeting - spawns a dedicated worker per session
    api.registerTool(() => ({
      name: "bighead_join_meeting",
      description:
        "Send Rebecca (Bighead AI avatar) to join a Zoom meeting. " +
        "Calls POST /api/sessions/start-by-email which: " +
        "(1) looks up the user by email in Bighead's DB, " +
        "(2) checks the per-user active session limit (max 3 concurrent), " +
        "(3) creates a meeting_session row for audit, " +
        "(4) spawns a dedicated zoom_service worker process for this session, " +
        "(5) kicks off the auto-join workflow in the background (SDK join → VoIP → video → audio → AI listener → TTS announcement). " +
        "Returns immediately with a session_id. Use bighead_leave_meeting with the session_id to disconnect.",
      parameters: Type.Object({
        user_email: Type.String({
          description:
            "Email of the registered Bighead user requesting the join. " +
            "Determines display name, session limits, and audit trail. Must exist in Bighead's user DB.",
        }),
        meeting_url: Type.String({
          description:
            "The Zoom meeting URL (e.g. https://zoom.us/j/123456789?pwd=abc). " +
            "Meeting ID and password are auto-extracted from the URL.",
        }),
        display_name: Type.Optional(
          Type.String({
            description:
              "Override display name for the avatar in the meeting. " +
              "Defaults to the user's registered profile display name in Bighead.",
          }),
        ),
        announcement: Type.Optional(
          Type.String({
            description:
              "Message Rebecca speaks via TTS after joining the meeting. " +
              "Defaults to 'Hello! I'm now connected and ready to chat.'",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const userEmail = params.user_email as string;
        const meetingUrl = params.meeting_url as string;
        const displayName = (params.display_name as string) ?? undefined;
        const announcement = (params.announcement as string) ?? undefined;

        try {
          const resp = await fetch(`${bigheadUrl()}/api/sessions/start-by-email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${bigheadToken()}`,
            },
            body: JSON.stringify({
              user_email: userEmail,
              meeting_url: meetingUrl,
              name: displayName,
              announcement,
            }),
          });

          const data = (await resp.json()) as Record<string, unknown>;

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: resp.ok,
                  session_id: data.session_id ?? null,
                  user_email: data.user_email ?? userEmail,
                  status: data.status ?? (resp.ok ? "initializing" : "failed"),
                  error: data.error ?? null,
                  code: data.code ?? null,
                }),
              },
            ],
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ok: false, error: message }),
              },
            ],
          };
        }
      },
    }));

    // bighead_analyze_transcript - send transcript text for structured extraction
    api.registerTool(() => ({
      name: "bighead_analyze_transcript",
      description:
        "Send a meeting transcript to Rebecca (Bighead AI) for structured order data extraction. " +
        "Returns extracted fields organized by ZW2 API sections with confidence notes for unclear fields.",
      parameters: Type.Object({
        transcript_text: Type.String({
          description: "The full VTT/text transcript content to analyze",
        }),
        system_prompt: Type.Optional(
          Type.String({ description: "Optional override for the extraction system prompt" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const resp = await fetch(`${bigheadUrl()}/api/analyze/transcript`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: params.transcript_text as string,
              system_prompt: (params.system_prompt as string) ?? undefined,
            }),
          });

          const data = (await resp.json()) as Record<string, unknown>;

          if (!resp.ok) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: data.error ?? `HTTP ${resp.status}` }) }],
            };
          }

          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ...data }) }],
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
          };
        }
      },
    }));

    // bighead_followup - multi-turn follow-up on a transcript analysis
    api.registerTool(() => ({
      name: "bighead_followup",
      description:
        "Follow up on a previous transcript analysis to ask about missing or unclear fields. " +
        "Uses the conversation_id from a prior bighead_analyze_transcript call to maintain context.",
      parameters: Type.Object({
        conversation_id: Type.String({
          description: "The conversation_id from a previous analyze_transcript response",
        }),
        message: Type.String({
          description: "The follow-up question or clarification request for Rebecca",
        }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const resp = await fetch(`${bigheadUrl()}/api/analyze/followup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversation_id: params.conversation_id as string,
              message: params.message as string,
            }),
          });

          const data = (await resp.json()) as Record<string, unknown>;

          if (!resp.ok) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: data.error ?? `HTTP ${resp.status}` }) }],
            };
          }

          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ...data }) }],
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
          };
        }
      },
    }));

    // bighead_leave_meeting - targets a specific worker session
    api.registerTool(() => ({
      name: "bighead_leave_meeting",
      description:
        "Tell Rebecca (Bighead AI avatar) to leave a Zoom meeting. " +
        "Pass the session_id returned by bighead_join_meeting to target the correct worker process. " +
        "Stops the SDK meeting, ends the zoom_service worker, and updates the session audit trail.",
      parameters: Type.Object({
        session_id: Type.String({
          description:
            "The session_id returned by bighead_join_meeting. " +
            "Identifies which worker/meeting to disconnect from.",
        }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const sessionId = params.session_id as string;

        try {
          const resp = await fetch(`${bigheadUrl()}/api/meeting/leave`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: sessionId }),
          });

          const data = (await resp.json()) as Record<string, unknown>;

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: resp.ok,
                  session_id: sessionId,
                  message: data.message ?? (resp.ok ? "Left meeting" : "Failed to leave"),
                }),
              },
            ],
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ok: false, error: message }),
              },
            ],
          };
        }
      },
    }));
  },
};

export default plugin;
