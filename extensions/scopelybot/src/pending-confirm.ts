// In-memory, single-use, TTL store for pending user-maintenance actions.
// An action only runs after a human types `CONFIRM <code>` in the channel — the
// LLM cannot fabricate that inbound message, so it cannot self-approve.

import { randomInt } from "node:crypto";

export type PendingAction = {
  code: string;
  conversationId: string; // channel the CONFIRM must come from
  summary: string; // human-readable description, echoed + audited
  run: () => Promise<{ ok: boolean; status: number; data: unknown }>;
  expiresAt: number;
};

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const store = new Map<string, PendingAction>();

function prune(): void {
  const now = Date.now();
  for (const [code, a] of store) {
    if (a.expiresAt <= now) {
      store.delete(code);
    }
  }
}

// 4-digit code, unpredictable (CSPRNG), unique within the live store. A guessable
// code lets the LLM fabricate a CONFIRM; randomInt closes that.
export function makeCode(): string {
  prune();
  let code = String(randomInt(1000, 10000));
  while (store.has(code)) {
    code = String(randomInt(1000, 10000));
  }
  return code;
}

export function putPending(a: Omit<PendingAction, "expiresAt">): void {
  prune();
  store.set(a.code, { ...a, expiresAt: Date.now() + TTL_MS });
}

// Where the CONFIRM arrived from, as observed by the dispatch pipeline.
export type ConfirmScope = {
  conversationId: string; // dispatch conversation the CONFIRM arrived in
  // True when the caller proved — via the agent-scoped session key — that the
  // CONFIRM arrived through ScopelyBot's own Zoom binding. Zoom thread-scoped
  // sessions dispatch with the THREAD id as conversationId, so an exact match
  // against the channel-JID-bound pending can never succeed for a threaded reply
  // (2026-07-20 incident: a 13-second-old code was reported "expired"). The
  // session-key prefix is the channel-binding proof in that case: scopelybot has
  // exactly one bound channel, so any `agent:scopelybot:zoom:*` session IS that
  // channel or a thread inside it.
  fromOwnZoomSurface?: boolean;
};

// Retrieve and consume a pending action (one-time use). Channel-scoped: a CONFIRM
// only fires an action staged for the SAME conversation (exact id match, or the
// caller's proof that the message came through this bot's own Zoom surface), so a
// code leaked/observed in another bot's channel cannot trigger a write staged here.
// A scope mismatch does NOT consume the action — the rightful channel can still
// confirm it.
export function takePending(code: string, scope: ConfirmScope): PendingAction | undefined {
  prune();
  const a = store.get(code);
  if (!a) {
    return undefined;
  }
  if (a.conversationId !== scope.conversationId && scope.fromOwnZoomSurface !== true) {
    return undefined;
  }
  store.delete(code);
  return a;
}
