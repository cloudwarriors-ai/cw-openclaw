import { randomUUID } from "node:crypto";
import type { Clock, SessionRecord } from "./types.js";

export class InMemorySessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly sessionTtlMs: number,
    private readonly clock: Clock = { now: () => Date.now() },
  ) {}

  create(params: { username: string; tenantId: string; displayName?: string }): SessionRecord {
    const now = this.clock.now();
    const session: SessionRecord = {
      sessionId: randomUUID(),
      username: params.username,
      tenantId: params.tenantId,
      displayName: params.displayName,
      createdAtMs: now,
      expiresAtMs: now + this.sessionTtlMs,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): SessionRecord | null {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return null;
    }
    if (record.expiresAtMs <= this.clock.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return record;
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clearExpired(): void {
    const now = this.clock.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAtMs <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
