// In-memory, single-use, TTL store for pending bigheadbot write actions.
// An action only runs after a human types `CONFIRM <code>` in the SAME channel the
// prompt was posted to — the LLM cannot fabricate that inbound message, and a
// CONFIRM from another channel/DM cannot consume it, so neither the model nor a
// bystander in a different conversation can approve a staged write.

import { randomInt } from "node:crypto";

export type PendingAction = {
  code: string;
  // The conversation the CONFIRM must come from. A staged write is bound to the
  // channel where its prompt was delivered; a CONFIRM from any other channel/DM
  // must NOT consume it (cross-channel confirm = privilege escalation).
  conversationId: string;
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

// Unpredictable 4-digit code, unique within the live store. crypto.randomInt — a
// confirm code is a security token, so it must NOT be derivable from call order or
// summary length (the old deterministic seed was guessable).
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

// Retrieve and consume a pending action (one-time use) — ONLY when the code exists
// AND the confirming conversation matches the one it was staged for. A CONFIRM from
// another channel returns undefined and leaves the action intact for the right one.
export function takePending(code: string, conversationId: string): PendingAction | undefined {
  prune();
  const a = store.get(code);
  if (!a || a.conversationId !== conversationId) {
    return undefined;
  }
  store.delete(code);
  return a;
}
