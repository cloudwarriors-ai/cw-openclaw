import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { errorResult, jsonResult, peOpsFetch } from "./ops-api.js";

type PeOpsToolSpec = {
  name: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  path: (toolParams: Record<string, unknown>) => string;
};

const peOpsToolGroups = {
  observe: [
    {
      name: "pe_ops_health",
      description:
        "Check Presales Knowledge Expert ops health: app, poller, Scopely reachability, schema cache, SMS webhook, and rollout health.",
      path: () => "/internal/ops/health",
      parameters: Type.Object({}),
    },
    {
      name: "pe_ops_active_engagements",
      description:
        "List active PE engagements with current stage, who is waiting, captured/missing field counts, and last event time.",
      path: () => "/internal/ops/active",
      parameters: Type.Object({}),
    },
    {
      name: "pe_ops_stuck_engagements",
      description:
        "List PE engagements that appear stuck or customer-impacting, including stage age and latest failure.",
      path: () => "/internal/ops/stuck",
      parameters: Type.Object({}),
    },
  ],
  channel: [
    subjectTool({
      name: "pe_ops_engagement_status",
      description:
        "Get PE engagement status by engagement/session id: stage, waiting state, customer summary, captured fields, and latest error.",
      segment: "engagement",
    }),
    subjectTool({
      name: "pe_ops_channel_status",
      description:
        "Get PE channel engagement status by Zoom channel id. Use when an operator only has the Zoom channel.",
      segment: "channel",
      paramName: "channel_id",
    }),
    subjectTool({
      name: "pe_ops_engagement_timeline",
      description:
        "Get a redacted PE activity timeline for an engagement/session/channel. Use to answer 'what happened?'",
      segment: "engagement",
      suffix: "/timeline",
    }),
  ],
  schema: [
    subjectTool({
      name: "pe_ops_schema_status",
      description:
        "Get PE schema status for an engagement/session: schema version, freshness, and last fetch error.",
      segment: "engagement",
      suffix: "/schema",
    }),
    subjectTool({
      name: "pe_ops_field_summary",
      description:
        "Get PE field capture summary for an engagement/session: captured, missing required, and rejected fields.",
      segment: "engagement",
      suffix: "/fields",
    }),
  ],
  sms: [
    subjectTool({
      name: "pe_ops_sms_status",
      description:
        "Get PE SMS engagement status by phone number or SMS session id, including rollout, delivery, and SOW delivery state.",
      segment: "sms",
      paramName: "phone_or_session",
    }),
  ],
} satisfies Record<string, readonly PeOpsToolSpec[]>;

export const PE_OPS_TOOL_GROUPS: Record<keyof typeof peOpsToolGroups, readonly string[]> = {
  observe: peOpsToolGroups.observe.map((tool) => tool.name),
  channel: peOpsToolGroups.channel.map((tool) => tool.name),
  schema: peOpsToolGroups.schema.map((tool) => tool.name),
  sms: peOpsToolGroups.sms.map((tool) => tool.name),
};

export function registerPeOpsTools(api: OpenClawPluginApi, logger: AuditLogger) {
  for (const group of Object.values(peOpsToolGroups)) {
    for (const tool of group) registerGet(api, logger, tool);
  }
}

function registerGet(api: OpenClawPluginApi, logger: AuditLogger, params: PeOpsToolSpec) {
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: params.name,
        description: params.description,
        parameters: params.parameters,
        async execute(_id: string, toolParams: Record<string, unknown>) {
          try {
            const result = await peOpsFetch(params.path(toolParams));
            return jsonResult({
              ok: result.ok,
              status: result.status,
              source: result.source,
              data: result.data,
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );
}

function subjectTool(params: {
  name: string;
  description: string;
  segment: string;
  paramName?: string;
  suffix?: string;
}): PeOpsToolSpec {
  const paramName = params.paramName ?? "id";
  return {
    name: params.name,
    description: params.description,
    parameters: Type.Object({
      [paramName]: Type.String({
        description: "Engagement, session, channel, phone, or related lookup id",
      }),
    }),
    path: (toolParams) =>
      `/internal/ops/${params.segment}/${encodeURIComponent(String(toolParams[paramName] ?? ""))}${params.suffix ?? ""}`,
  };
}
