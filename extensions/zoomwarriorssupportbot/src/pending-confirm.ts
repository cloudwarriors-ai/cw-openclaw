// In-memory, single-use, TTL store for pending zws write actions.
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

// Retrieve and consume a pending action (one-time use). Channel-scoped: a CONFIRM
// only fires an action staged for the SAME conversation, so a code leaked/observed
// in one channel cannot trigger a write staged for another. A channel mismatch does
// NOT consume the action — the rightful channel can still confirm it.
export function takePending(code: string, conversationId: string): PendingAction | undefined {
  prune();
  const a = store.get(code);
  if (!a || a.conversationId !== conversationId) {
    return undefined;
  }
  store.delete(code);
  return a;
}
