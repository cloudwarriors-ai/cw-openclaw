// In-memory, single-use, TTL store for pending user-maintenance actions.
// An action only runs after a human types `CONFIRM <code>` in the channel — the
// LLM cannot fabricate that inbound message, so it cannot self-approve.

import { randomBytes } from "node:crypto";

export type PendingAction = {
  code: string;
  conversationId: string; // channel the CONFIRM must come from
  summary: string; // exact server/legacy description, audited unchanged
  backendAction?: { pending_action_id: string; preview_sha256: string };
  displaySummary?: string; // validated native presentation; never execution input
  // Executes the staged mutation. Receives the confirming actor's id so actions
  // that record WHO approved them (e.g. approver grants) can do so; most staged
  // API calls ignore it.
  run: (ctx?: { actor?: string }) => Promise<{ ok: boolean; status: number; data: unknown }>;
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

// Per-action128-bit token: consumed/expired actions and process restarts must
// not recycle the small four-digit namespace into a different approval. Live
// collisions are excluded; cross-lifetime non-reuse relies on CSPRNG entropy.
export function makeCode(): string {
  prune();
  let code = randomBytes(16).toString("hex");
  while (store.has(code)) {
    code = randomBytes(16).toString("hex");
  }
  return code;
}

export function putPending(a: Omit<PendingAction, "expiresAt">): void {
  prune();
  if (store.has(a.code)) {
    throw new Error("A confirmation token already has a pending action");
  }
  store.set(a.code, { ...a, expiresAt: Date.now() + TTL_MS });
}

// Dispatch supplies the actual channel JID for both root and threaded Zoom
// messages. Agent identity or a thread session prefix is not channel authority.
export type ConfirmScope = { conversationId: string };

// A mismatch never consumes the code; the rightful channel can still confirm.
export function takePending(code: string, scope: ConfirmScope): PendingAction | undefined {
  prune();
  const a = store.get(code);
  if (!a) {
    return undefined;
  }
  if (!scope.conversationId || a.conversationId !== scope.conversationId) {
    return undefined;
  }
  store.delete(code);
  return a;
}
