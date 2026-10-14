import { boundedText } from "./audit-chain.js";

// An epoch identifies an uninterrupted sender sequence, not a person. Symbols
// are never reused after eviction/reset, so an old run cannot regain authority.
const sessions = new Map<string, { sender: string; epoch: symbol; changedAt: number }>();
const MAX_TRACKED_SESSIONS = 1000;

export function rememberRequester(session: string, canonicalSender: string): void {
  const key = boundedText(session);
  const previous = sessions.get(key);
  const unchanged = canonicalSender && previous?.sender === canonicalSender;
  const epoch = unchanged ? previous.epoch : Symbol();
  const changedAt = unchanged ? previous.changedAt : performance.now();
  sessions.delete(key);
  sessions.set(key, { sender: canonicalSender, epoch, changedAt });
  if (sessions.size > MAX_TRACKED_SESSIONS) {
    sessions.delete(sessions.keys().next().value as string);
  }
}

/** Lazy factories may rebuild tools; only a run begun after this epoch can bind it. */
export function captureRequesterEpoch(
  session: string | undefined,
  requesterRunStartedAt: number | undefined,
): symbol | undefined {
  const current = session ? sessions.get(boundedText(session)) : undefined;
  return current &&
    typeof requesterRunStartedAt === "number" &&
    Number.isFinite(requesterRunStartedAt) &&
    requesterRunStartedAt > current.changedAt
    ? current.epoch
    : undefined;
}

export function requesterEpochMatches(
  session: string,
  sender: string,
  epoch: symbol | undefined,
): boolean {
  const current = sessions.get(boundedText(session));
  return epoch !== undefined && current?.epoch === epoch && current.sender === sender;
}

export function resetInboundSendersForTest(): void {
  if (!process.env.VITEST) {
    throw new Error("resetInboundSendersForTest is test-only");
  }
  sessions.clear();
}
