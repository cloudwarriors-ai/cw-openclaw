// Server roster is the authority. No positive cache or file/config fallback.
import { readBackendProfile } from "./backend-profile.js";
import { currentWriteRequester } from "./ops-client.js";
import { nativeWriteScope } from "./ops-write-policy.js";
import { redactText } from "./redaction.js";
import { canonicalZoomId, jsonResult, scopelyOpsInvoke } from "./scopely-api.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function localScope(): string | undefined {
  return nativeWriteScope(readBackendProfile(), process.env.SCOPELYBOT_ZOOM_CHANNEL);
}
async function read(
  capability: "ops.approvers.check" | "ops.approvers.list",
  actor: string,
  args: Record<string, unknown>,
) {
  const scope = localScope();
  const sender = canonicalZoomId(actor);
  if (
    !scope ||
    !sender ||
    redactText(sender) !== sender ||
    /zwops_|^(?:pk_live_|sk_|ghp_|gho_|xox[abp]-)/i.test(sender) ||
    (sender.length >= 32 && /[a-z]/i.test(sender) && /[0-9]/.test(sender))
  ) {
    return undefined;
  }
  const response = await scopelyOpsInvoke({ capability, requesterZoomId: sender, args });
  const body = response.data;
  if (
    localScope() !== scope ||
    !response.ok ||
    response.truncated ||
    !record(body) ||
    body.ok !== true ||
    body.capability !== capability ||
    !record(body.data) ||
    JSON.stringify(body.data).length > 12_000
  ) {
    return undefined;
  }
  return body.data;
}

/** Called only with the actual trusted inbound sender, never model arguments. */
export async function isCurrentApprover(actor: string): Promise<boolean> {
  try {
    const data = await read("ops.approvers.check", actor, {});
    return data?.eligible === true && positive(data.user_id) && positive(data.scope_revision);
  } catch {
    return false;
  }
}

export async function opsRosterList(args: Record<string, unknown>) {
  const refused = () =>
    jsonResult({
      ok: false,
      error: "The current server roster is unavailable or not authorized.",
    });
  try {
    const sender = currentWriteRequester();
    if (!sender) {
      return refused();
    }
    const data = await read("ops.approvers.list", sender, args);
    if (currentWriteRequester() !== sender) {
      return refused();
    }
    if (
      !data ||
      !Array.isArray(data.items) ||
      data.items.length > 50 ||
      !Number.isSafeInteger(data.total) ||
      (data.total as number) < data.items.length ||
      typeof data.truncated !== "boolean" ||
      !(data.next_offset === null || positive(data.next_offset)) ||
      data.truncated !== (data.next_offset !== null) ||
      !data.items.every(
        (item) =>
          record(item) &&
          positive(item.user_id) &&
          positive(item.revision) &&
          typeof item.active === "boolean" &&
          typeof item.seeded === "boolean",
      )
    ) {
      return refused();
    }
    const offset = args.offset ?? 0;
    if (
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0 ||
      (data.next_offset !== null &&
        (data.items.length === 0 ||
          data.next_offset !== (offset as number) + data.items.length ||
          data.next_offset >= (data.total as number)))
    ) {
      return refused();
    }
    return jsonResult({ ok: true, untrusted_output: true, data });
  } catch {
    return refused();
  }
}
