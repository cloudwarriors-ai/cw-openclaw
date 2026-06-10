// Dedicated SQLite store for the test-capture harness. Holds three concerns:
//   - control:           the currently-armed capture-set (which channel JIDs to
//                        capture+suppress) + the active runId, set by the harness.
//   - captured_outbound: Zoom channel/DM messages the bot WOULD have sent, recorded
//                        instead of being delivered (egress interceptor).
//   - tool_trace:        every tool call (incl. sessions_spawn) + agent_end events,
//                        for hub-and-spoke routing assertions (before_tool_call hook).
//
// This is ephemeral TEST infrastructure, not product runtime state — a narrowly
// justified dedicated SQLite DB (node:sqlite directly so the extension keeps to the
// plugin boundary and does not import core `src/**`). WAL mode lets the in-gateway
// writer and the out-of-process harness reader share the file concurrently.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_DB_PATH = "/root/.openclaw/test-capture/capture.sqlite";

export type ArmedState = { channels: string[]; runId: string | null };

export type OutboundRecord = {
  runId: string | null;
  ts: number;
  endpoint: "channel" | "dm";
  toJid: string;
  robotJid: string | null;
  text: string;
  headText: string | null;
  replyTo: string | null;
  replyMainMessageId: string | null;
  rawJson: string;
};

export type TraceRecord = {
  runId: string | null;
  ts: number;
  kind: "tool_call" | "agent_end";
  agentId: string | null;
  channelId: string | null;
  sessionKey: string | null;
  toolName: string | null;
  targetAgentId: string | null; // for sessions_spawn: which spoke was targeted
  paramsJson: string | null;
};

export function openStore(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 4000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      armed_channels TEXT NOT NULL DEFAULT '',
      active_run_id TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS captured_outbound (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT, ts INTEGER NOT NULL,
      endpoint TEXT NOT NULL, to_jid TEXT NOT NULL, robot_jid TEXT,
      text TEXT NOT NULL, head_text TEXT, reply_to TEXT, reply_main_message_id TEXT,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tool_trace (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
      agent_id TEXT, channel_id TEXT, session_key TEXT,
      tool_name TEXT, target_agent_id TEXT, params_json TEXT
    );
    CREATE INDEX IF NOT EXISTS captured_outbound_run_idx ON captured_outbound(run_id, ts);
    CREATE INDEX IF NOT EXISTS tool_trace_run_idx ON tool_trace(run_id, ts);
  `);
  db.prepare(
    `INSERT OR IGNORE INTO control (id, armed_channels, active_run_id, updated_at) VALUES (1, '', NULL, ?)`,
  ).run(Date.now());
  return db;
}

export function getArmed(db: DatabaseSync): ArmedState {
  const row = db.prepare(`SELECT armed_channels, active_run_id FROM control WHERE id = 1`).get() as
    | { armed_channels: string; active_run_id: string | null }
    | undefined;
  const channels = (row?.armed_channels ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { channels, runId: row?.active_run_id ?? null };
}

export function setArmed(db: DatabaseSync, channels: string[], runId: string | null): void {
  db.prepare(`UPDATE control SET armed_channels = ?, active_run_id = ?, updated_at = ? WHERE id = 1`).run(
    channels.join(","),
    runId,
    Date.now(),
  );
}

export function recordOutbound(db: DatabaseSync, r: OutboundRecord): void {
  db.prepare(
    `INSERT INTO captured_outbound
       (run_id, ts, endpoint, to_jid, robot_jid, text, head_text, reply_to, reply_main_message_id, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.runId,
    r.ts,
    r.endpoint,
    r.toJid,
    r.robotJid,
    r.text,
    r.headText,
    r.replyTo,
    r.replyMainMessageId,
    r.rawJson,
  );
}

export function recordTrace(db: DatabaseSync, r: TraceRecord): void {
  db.prepare(
    `INSERT INTO tool_trace
       (run_id, ts, kind, agent_id, channel_id, session_key, tool_name, target_agent_id, params_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.runId,
    r.ts,
    r.kind,
    r.agentId,
    r.channelId,
    r.sessionKey,
    r.toolName,
    r.targetAgentId,
    r.paramsJson,
  );
}
