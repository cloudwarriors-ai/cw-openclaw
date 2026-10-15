// Native canonical identities and server roster; no observed-email/file authority.
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { opsRosterList } from "./ops-roster-client.js";
import { opsStageWrite } from "./ops-write-client.js";

export function registerApproverTools(api: OpenClawPluginApi, logger: AuditLogger) {
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_approvers",
        description:
          "List the current server approver roster in an admitted local or production mode. Requires a mapped native platform administrator with roster membership. Entries grant bot confirmation eligibility only, never application roles. Production roster grant/revoke and Claude person-token roster administration are unavailable.",
        parameters: Type.Object(
          {
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
            offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })),
          },
          { additionalProperties: true },
        ),
        execute: async (_id: string, args: Record<string, unknown>) => opsRosterList(args),
      },
      logger,
    ),
  );
  for (const action of ["grant", "revoke"] as const) {
    api.registerTool(() =>
      wrapToolWithAudit(
        {
          name: `scopely_${action}_approver`,
          description: `${action === "grant" ? "Grant" : "Revoke"} local bot confirmation eligibility for a uniquely mapped native platform administrator at a synthetic .invalid email. Requires native administrator request permission and an existing eligible approver's human CONFIRM. Canonical identity comes from the app, never a channel display name. Seeded entries require host operator maintenance; no application roles are changed.`,
          parameters: Type.Object(
            { email: Type.String({ minLength: 3, maxLength: 254 }) },
            { additionalProperties: true },
          ),
          execute: async (_id: string, args: Record<string, unknown>) =>
            opsStageWrite(`ops.approvers.${action}`, args),
        },
        logger,
      ),
    );
  }
}
