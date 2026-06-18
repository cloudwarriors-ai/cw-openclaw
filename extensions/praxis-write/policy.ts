/**
 * Code-enforced write policy for the Praxis operator tools.
 *
 * The SKILL/prompt is NOT the gate (spar CRITICAL: prompt-injection on a
 * chat-reachable, side-effecting surface). The gate is here, in code:
 *   1. Identity comes from the trusted runtime context (requesterSenderId,
 *      delivery channel) — never from model-supplied tool args, so a prompt
 *      cannot spoof who is asking.
 *   2. An explicit user/channel allowlist (plugin config). Empty = fail closed.
 *   3. A two-step dry-run/confirm: the confirm token is an HMAC bound to the
 *      issue's current state, so a confirm the model fabricates (skipping the
 *      preview) or that races a state change is rejected.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { PraxisIssueState } from "./praxis-write-client.js";

/** Trusted, runtime-supplied request context. Mirrors the OpenClaw tool context
 * fields we read; declared structurally so this module stays pure + unit-testable. */
export interface ToolRequestContext {
  requesterSenderId?: string;
  messageChannel?: string;
  deliveryContext?: { channel?: string; threadId?: string | number };
  sessionId?: string;
}

export interface ActorContext {
  requestedBy: string;
  channel: string;
  messageId: string;
  toolCallId: string;
}

export interface WritePolicyConfig {
  allowedUsers: string[];
  allowedChannels: string[];
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** Coerce the raw plugin config into the policy allowlists, defaulting to empty
 * (fail closed) when unset or malformed. */
export function resolveWritePolicyConfig(raw: unknown): WritePolicyConfig {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    allowedUsers: toStringArray(obj.allowedUsers),
    allowedChannels: toStringArray(obj.allowedChannels),
  };
}

/** Build the actor context from the TRUSTED runtime context, not tool args. The
 * model can pick the issue + reason, but never who/where the request came from. */
export function deriveActorContext(ctx: ToolRequestContext, toolCallId: string): ActorContext {
  const channel = ctx.deliveryContext?.channel ?? ctx.messageChannel ?? "";
  const threadId = ctx.deliveryContext?.threadId;
  const messageId =
    threadId !== undefined && threadId !== null ? String(threadId) : (ctx.sessionId ?? "");
  return {
    requestedBy: ctx.requesterSenderId ?? "",
    channel,
    messageId,
    toolCallId,
  };
}

/** Each configured dimension must match; an empty allowlist authorizes nobody.
 * A missing requester identity always denies (cannot attribute the action). */
export function checkPolicy(actor: ActorContext, config: WritePolicyConfig): PolicyDecision {
  if (!actor.requestedBy) {
    return { allowed: false, reason: "no_requester_identity" };
  }
  const { allowedUsers, allowedChannels } = config;
  if (allowedUsers.length === 0 && allowedChannels.length === 0) {
    return { allowed: false, reason: "write_policy_unconfigured" };
  }
  if (allowedUsers.length > 0 && !allowedUsers.includes(actor.requestedBy)) {
    return { allowed: false, reason: "requester_not_allowlisted" };
  }
  if (allowedChannels.length > 0 && !allowedChannels.includes(actor.channel)) {
    return { allowed: false, reason: "channel_not_allowlisted" };
  }
  return { allowed: true };
}

/** HMAC over (kind + the issue's identity and current state), keyed by the API
 * token (never exposed to the model). Knowing the token is impossible for the
 * model, so it cannot forge a token without first calling the dry-run; binding
 * to state/version makes a stale confirm fail closed. */
export function mintConfirmToken(params: {
  secret: string;
  kind: string;
  issue: PraxisIssueState;
}): string {
  const { secret, kind, issue } = params;
  const msg = `${kind}:${issue.id}:${issue.state}:${issue.state_reason}:${issue.version}`;
  return createHmac("sha256", secret).update(msg).digest("hex").slice(0, 16);
}

/** Constant-time compare of a presented confirm token against the expected one. */
export function confirmTokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Idempotency key for a confirmed command: one logical "do <kind> to issue N at
 * version V", so a double-fire of the same command dedupes server-side. */
export function idempotencyKey(kind: string, issue: PraxisIssueState): string {
  return `${kind}:${issue.id}:${issue.version}`;
}
