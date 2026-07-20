// Runtime write-approver store for scopelybot, with an observed-identity ledger.
//
// The config-seeded `writeApproverIds` (openclaw.json plugin config) are PERMANENT
// approvers — they cannot be revoked from chat, only by editing the config. On top
// of that, this store holds chat-GRANTED approvers: an existing approver stages a
// grant via the scopely_grant_approver tool and executes it with `CONFIRM <code>`,
// exactly like every other gated write. Grants persist to a JSON file in the
// workspace dir so a container restart does not silently drop access.
//
// Identity ledger: humans name people by email, but the confirm gate matches Zoom
// operator_ids. Every inbound channel message carries (operator_id, operator email)
// in its webhook payload, so we record each sender we see and resolve email →
// operator_id from observation. No Zoom admin API needed; the only requirement is
// that the target has posted at least one message the bot received.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type GrantEntry = {
  operatorId: string;
  email: string;
  grantedBy: string; // operator_id of the approver whose CONFIRM executed the grant
  grantedAt: string; // ISO timestamp
};

type PersistedState = {
  grants: GrantEntry[];
  identities: Record<string, string>; // lowercased email -> operator_id
};

export type ApproverStore = {
  /** Config-seeded + chat-granted ids, normalized — feed to isApprovedWriteActor. */
  approverIds(): string[];
  /** Chat-granted entries only (config ids are listed separately). */
  listGrants(): GrantEntry[];
  configuredIds(): string[];
  /** Add a granted approver. Returns false when already an approver (either tier). */
  grant(entry: { operatorId: string; email: string; grantedBy: string }): boolean;
  /** Remove a chat-granted approver by operator id. Config-seeded ids are refused. */
  revoke(operatorId: string): { removed: boolean; reason?: string };
  /** Record a sender identity observed on an inbound channel message. */
  recordSeenIdentity(operatorId: string | undefined, email: string | undefined): void;
  /** Resolve an email to the operator_id observed for it, if any. */
  resolveOperatorId(email: string): string | undefined;
  /** Reverse lookup for display: operator_id -> observed email, if any. */
  emailForOperatorId(operatorId: string): string | undefined;
};

const STATE_FILE = "scopelybot-approvers.json";
// The channel has a bounded human population; cap the ledger so a busy gateway can
// never grow the state file without bound.
const MAX_IDENTITIES = 500;

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

// Load persisted state, tolerating a missing or corrupt file (start empty rather
// than crash plugin registration — grants are re-creatable through the same flow).
function loadState(path: string): PersistedState {
  try {
    if (!existsSync(path)) return { grants: [], identities: {} };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedState>;
    return {
      grants: Array.isArray(parsed.grants) ? parsed.grants : [],
      identities:
        parsed.identities && typeof parsed.identities === "object" ? parsed.identities : {},
    };
  } catch {
    return { grants: [], identities: {} };
  }
}

export function createApproverStore(opts: {
  workspaceDir: string;
  configuredIds: string[];
}): ApproverStore {
  const path = join(opts.workspaceDir, STATE_FILE);
  const configured = [...new Set(opts.configuredIds.map(normalizeId).filter(Boolean))];
  const state = loadState(path);

  // Persist via write-then-rename so a crash mid-write cannot corrupt the file.
  function save(): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path);
  }

  return {
    approverIds() {
      return [...new Set([...configured, ...state.grants.map((g) => normalizeId(g.operatorId))])];
    },
    listGrants() {
      return [...state.grants];
    },
    configuredIds() {
      return [...configured];
    },
    grant(entry) {
      const id = normalizeId(entry.operatorId);
      if (!id) return false;
      if (configured.includes(id)) return false;
      if (state.grants.some((g) => normalizeId(g.operatorId) === id)) return false;
      state.grants.push({
        operatorId: entry.operatorId.trim(),
        email: entry.email.trim().toLowerCase(),
        grantedBy: entry.grantedBy,
        grantedAt: new Date().toISOString(),
      });
      save();
      return true;
    },
    revoke(operatorId) {
      const id = normalizeId(operatorId);
      if (configured.includes(id)) {
        return {
          removed: false,
          reason:
            "This approver is seeded from the deployment config (openclaw.json) and can only be removed by editing that config.",
        };
      }
      const before = state.grants.length;
      state.grants = state.grants.filter((g) => normalizeId(g.operatorId) !== id);
      if (state.grants.length === before) {
        return { removed: false, reason: "No chat-granted approver with that identity." };
      }
      save();
      return { removed: true };
    },
    recordSeenIdentity(operatorId, email) {
      if (!operatorId?.trim() || !email?.trim() || !email.includes("@")) return;
      const key = email.trim().toLowerCase();
      if (state.identities[key] === operatorId.trim()) return; // no-op, skip disk write
      if (Object.keys(state.identities).length >= MAX_IDENTITIES && !(key in state.identities)) {
        return;
      }
      state.identities[key] = operatorId.trim();
      save();
    },
    resolveOperatorId(email) {
      return state.identities[email.trim().toLowerCase()];
    },
    emailForOperatorId(operatorId) {
      // Case-insensitive: callers may hold the normalized (lowercased) id while the
      // ledger stores the raw webhook casing.
      const id = normalizeId(operatorId);
      for (const [email, oid] of Object.entries(state.identities)) {
        if (normalizeId(oid) === id) return email;
      }
      return undefined;
    },
  };
}
