// In-memory, single-use, TTL store for pending zws write actions.
// An action only runs after a human types `CONFIRM <code>` in the channel — the
// LLM cannot fabricate that inbound message, so it cannot self-approve.

export type PendingAction = {
  code: string;
  summary: string; // human-readable description, echoed + audited
  run: () => Promise<{ ok: boolean; status: number; data: unknown }>;
  expiresAt: number;
};

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const store = new Map<string, PendingAction>();

function prune(): void {
  const now = Date.now();
  for (const [code, a] of store) {
    if (a.expiresAt <= now) store.delete(code);
  }
}

// 4-digit code, unique within the live store. `seed` varies per call.
export function makeCode(seed: number): string {
  prune();
  let code = String(1000 + (Math.abs(seed) % 9000));
  let bump = 0;
  while (store.has(code)) code = String(1000 + (Math.abs(seed + ++bump) % 9000));
  return code;
}

export function putPending(a: Omit<PendingAction, "expiresAt">): void {
  prune();
  store.set(a.code, { ...a, expiresAt: Date.now() + TTL_MS });
}

// Retrieve and consume a pending action (one-time use).
export function takePending(code: string): PendingAction | undefined {
  prune();
  const a = store.get(code);
  if (!a) return undefined;
  store.delete(code);
  return a;
}
