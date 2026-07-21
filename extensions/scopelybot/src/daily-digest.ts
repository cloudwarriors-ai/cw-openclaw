// Daily digest for scopelybot (Slice 4, decision ratified 2026-07-20: post to
// the vipbot_prod Zoom channel). One deterministic summary per day — stats
// delta vs yesterday's snapshot, pending approvals, possibly-stuck deals,
// extraction errors — built from the SAME read-only BFF endpoints the chat
// tools use and formatted entirely in code (no model in the loop; the digest
// is a report, not a conversation).
//
// Scheduling rides the passthrough-runner pattern (gateway:startup interval,
// unref'd, gateway:shutdown cleanup — index.ts) but fires once per day: a
// minute-granularity tick checks "past the configured hour AND not yet posted
// today (UTC)", with the last-posted date persisted in the workspace so a
// container restart can neither double-post nor skip a day.
//
// Failure posture: every fetch is independent and fail-soft — a section that
// errors renders as "unavailable" instead of suppressing the digest. Sends
// are best-effort (see runDigestTick). All reads; zero writes; the confirm
// gate is not involved.

import * as fs from "fs";
import * as path from "path";
import { sendScopelyText } from "./comfort.js";
import { scopelyFetch } from "./scopely-api.js";

export function dailyDigestEnabled(): boolean {
  return process.env.SCOPELYBOT_DAILY_DIGEST === "1";
}

// UTC hour (0-23) after which the digest fires. Default 13:00 UTC = 9am ET.
export function digestHourUtc(): number {
  const raw = Number(process.env.SCOPELYBOT_DIGEST_HOUR_UTC ?? "13");
  return Number.isFinite(raw) && raw >= 0 && raw <= 23 ? Math.floor(raw) : 13;
}

// In-progress sessions CREATED more than this many days ago are flagged as
// possibly stuck. Created-date is the only staleness dimension the admin
// sessions list can filter on (no ordering/updated_at params — verified
// against SessionAdminViewSet._filtered_queryset).
const STUCK_AFTER_DAYS = 7;

// Zoom chatbot messages cap near 4096 chars (core adapter chunks agent
// replies at 4000 — extensions/zoom/src/outbound.ts). sendScopelyText posts
// raw, so the digest chunks itself on line boundaries under the same limit.
const CHUNK_LIMIT = 4000;

type DigestState = { lastPostedDate?: string; statsSnapshot?: Record<string, unknown> };

function stateFile(workspaceDir: string): string {
  return path.join(workspaceDir, "scopelybot", "daily-digest.json");
}

export function readDigestState(workspaceDir: string): DigestState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(workspaceDir), "utf8")) as DigestState;
  } catch {
    return {};
  }
}

function writeDigestState(workspaceDir: string, state: DigestState): void {
  const file = stateFile(workspaceDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {
    // Best-effort: a lost marker only risks one duplicate digest after restart.
  }
}

function utcDateKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

// True when this tick should build+post: flag on, past the configured hour,
// not yet posted today.
export function digestDue(workspaceDir: string, now: number): boolean {
  if (!dailyDigestEnabled()) return false;
  const d = new Date(now);
  if (d.getUTCHours() < digestHourUtc()) return false;
  return readDigestState(workspaceDir).lastPostedDate !== utcDateKey(now);
}

// --- section builders (each fail-soft) --------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function countOf(v: unknown): number | undefined {
  if (Array.isArray(v)) return v.length;
  const r = asRecord(v);
  if (typeof r.count === "number") return r.count;
  if (Array.isArray(r.results)) return r.results.length;
  return undefined;
}

// Render "42 (+5)" style deltas for numeric stats present in both snapshots.
function statsLine(current: Record<string, unknown>, previous: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(current)) {
    if (typeof value !== "number") continue;
    const prev = previous[key];
    const delta = typeof prev === "number" ? value - prev : undefined;
    const deltaText =
      delta === undefined || delta === 0 ? "" : ` (${delta > 0 ? "+" : ""}${delta})`;
    parts.push(`${key.replace(/_/g, " ")}: ${value}${deltaText}`);
    if (parts.length >= 6) break;
  }
  return parts.length > 0 ? parts.join(", ") : "no numeric stats available";
}

export type DigestResult = { text: string; statsSnapshot?: Record<string, unknown> };

// Build the digest text from the four read planes. Never throws.
export async function buildDigest(previousStats: Record<string, unknown>): Promise<DigestResult> {
  const lines: string[] = ["Daily Scopely VIP digest"];

  let statsSnapshot: Record<string, unknown> | undefined;
  try {
    const stats = await scopelyFetch("/api/admin/stats/");
    if (stats.ok) {
      const flat = asRecord(stats.data);
      statsSnapshot = flat;
      lines.push(`Stats: ${statsLine(flat, previousStats)}`);
    } else {
      lines.push(`Stats: unavailable (HTTP ${stats.status})`);
    }
  } catch {
    lines.push("Stats: unavailable");
  }

  try {
    const approvals = await scopelyFetch("/api/admin/approvals/");
    const n = approvals.ok ? countOf(approvals.data) : undefined;
    lines.push(
      approvals.ok
        ? `Pending approvals: ${n ?? "unknown"}`
        : `Pending approvals: unavailable (HTTP ${approvals.status})`,
    );
  } catch {
    lines.push("Pending approvals: unavailable");
  }

  try {
    const cutoff = new Date(Date.now() - STUCK_AFTER_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const stuck = await scopelyFetch(
      `/api/admin/sessions/?status=in_progress&date_to=${cutoff}&limit=5`,
    );
    if (stuck.ok) {
      const rows = Array.isArray(asRecord(stuck.data).results)
        ? (asRecord(stuck.data).results as unknown[])
        : Array.isArray(stuck.data)
          ? (stuck.data as unknown[])
          : [];
      const total = countOf(stuck.data) ?? rows.length;
      const names = rows
        .slice(0, 3)
        .map((row) => {
          const r = asRecord(row);
          return `#${r.id ?? "?"} ${r.company_name ?? r.company ?? ""}`.trim();
        })
        .filter((s) => s !== "#?");
      lines.push(
        total > 0
          ? `Possibly stuck (in progress, created >${STUCK_AFTER_DAYS}d ago): ${total}` +
              (names.length > 0 ? ` — ${names.join(", ")}` : "")
          : "Possibly stuck deals: none",
      );
    } else {
      lines.push(`Possibly stuck deals: unavailable (HTTP ${stuck.status})`);
    }
  } catch {
    lines.push("Possibly stuck deals: unavailable");
  }

  try {
    const failed = await scopelyFetch("/api/extraction-monitor/sessions/?status=failed&limit=5");
    const n = failed.ok ? countOf(failed.data) : undefined;
    lines.push(
      failed.ok
        ? n && n > 0
          ? `Extraction failures: ${n}`
          : "Extraction failures: none"
        : `Extraction failures: unavailable (HTTP ${failed.status})`,
    );
  } catch {
    lines.push("Extraction failures: unavailable");
  }

  return { text: lines.join("\n"), ...(statsSnapshot ? { statsSnapshot } : {}) };
}

// Split on line boundaries under the Zoom limit (defensive: today's digest is
// far below it, but section growth must degrade to extra messages, not a
// silent Zoom-side truncation).
export function chunkDigestText(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = line;
    } else if (candidate.length > limit) {
      chunks.push(candidate.slice(0, limit));
      current = candidate.slice(limit);
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// One digest tick: check due, build, post, persist the marker + snapshot.
// Sends are best-effort (sendScopelyText swallows Zoom errors by design, same
// as the confirm prompt and escalation posts), so the marker is written after
// the send loop regardless — a Zoom outage costs that day's digest rather
// than producing a retry storm against a down API.
//
// Overlap guard: the interval fires every minute but a build against a slow
// backend can exceed that — a second tick would read the still-unwritten
// marker and double-post. Single-process module state is sufficient (one
// gateway process owns the interval).
let tickInFlight = false;

export async function runDigestTick(
  workspaceDir: string,
  deps?: { now?: () => number; send?: typeof sendScopelyText },
): Promise<boolean> {
  const now = deps?.now ? deps.now() : Date.now();
  if (tickInFlight) return false;
  if (!digestDue(workspaceDir, now)) return false;
  const channel = process.env.SCOPELYBOT_ZOOM_CHANNEL ?? "";
  if (!channel) return false;

  tickInFlight = true;
  try {
    const state = readDigestState(workspaceDir);
    const digest = await buildDigest(asRecord(state.statsSnapshot));
    const send = deps?.send ?? sendScopelyText;
    for (const chunk of chunkDigestText(digest.text)) {
      await send(channel, chunk);
    }
    writeDigestState(workspaceDir, {
      lastPostedDate: utcDateKey(now),
      ...(digest.statsSnapshot ? { statsSnapshot: digest.statsSnapshot } : {}),
    });
    return true;
  } finally {
    tickInFlight = false;
  }
}
