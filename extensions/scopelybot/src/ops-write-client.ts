// Backend pending state is authoritative. The existing Zoom code map only
// delivers the human prompt and carries its pending reference to confirmation.
import { readBackendProfile } from "./backend-profile.js";
import { stageWrite } from "./gated.js";
import { currentWriteRequester } from "./ops-client.js";
import { canonicalZoomId, errorResult, jsonResult, scopelyOpsInvoke } from "./scopely-api.js";

type LocalWrite =
  | "catalog.project_types.update"
  | "catalog.deployment_types.update"
  | "catalog.scoping_cards.create"
  | "catalog.scoping_cards.update"
  | "catalog.scoping_cards.delete"
  | "pricing.items.create"
  | "pricing.items.update";
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function opsStageWrite(capability: LocalWrite, args: Record<string, unknown>) {
  try {
    const profile = readBackendProfile();
    const requester = currentWriteRequester();
    const channel = process.env.SCOPELYBOT_ZOOM_CHANNEL;
    if (profile.env !== "local" || profile.mode !== "read-write" || !requester || !channel) {
      return jsonResult({
        ok: false,
        error:
          "Local write staging requires the current Zoom sender and a local read-write profile.",
      });
    }
    const response = await scopelyOpsInvoke({ capability, args, requesterZoomId: requester });
    const body = response.data;
    const data = record(body) && body.ok === true && record(body.data) ? body.data : undefined;
    if (
      !response.ok ||
      !data ||
      data.confirmation_required !== true ||
      data.state !== "pending" ||
      typeof data.pending_action_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        data.pending_action_id,
      ) ||
      typeof data.preview !== "string"
    ) {
      return jsonResult({
        ok: false,
        error: "The application did not prepare a confirmable change.",
      });
    }
    const pendingId = data.pending_action_id;
    return await stageWrite(
      data.preview,
      async (context) => {
        const actor = canonicalZoomId(context?.actor);
        // This callback is called only by the trusted inbound CONFIRM gate.
        // Never substitute the requesting sender or an argument from the model.
        if (!actor || process.env.SCOPELYBOT_ZOOM_CHANNEL !== channel) {
          return {
            ok: false,
            status: 403,
            data: { detail: "Confirmation identity or channel changed." },
          };
        }
        const confirmed = await scopelyOpsInvoke({
          capability: "ops.confirm",
          args: { pending_action_id: pendingId },
          requesterZoomId: actor,
        });
        const envelope = confirmed.data;
        const outcome =
          record(envelope) && envelope.ok === true && record(envelope.data)
            ? envelope.data
            : undefined;
        // HTTP200 includes pending, failed and reconciliation states: only the
        // durable succeeded state means the human's requested change completed.
        return {
          ok: confirmed.ok && outcome?.state === "succeeded",
          status: outcome?.state === "succeeded" ? 200 : 409,
          data:
            outcome?.state === "succeeded"
              ? outcome.result
              : {
                  detail: outcome?.reconcile_required
                    ? "Outcome uncertain; reconcile the pending action before any new attempt."
                    : "The application did not apply this change.",
                },
        };
      },
      true,
    );
  } catch (error) {
    return errorResult(error);
  }
}
