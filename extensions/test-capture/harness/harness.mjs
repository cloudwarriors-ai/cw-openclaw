// test-capture harness library + CLI. Runs INSIDE the container (Node 22, node:sqlite).
// One scenario = arm a channel → reset its session → inject a synthetic signed webhook
// → wait for the turn to go quiescent → read captured outbound + tool trace → derive a
// hub-and-spoke summary. Nothing is delivered to the real Zoom channel (egress is
// captured+suppressed by the test-capture extension for the armed channel).
//
// Usage:  node harness.mjs <profile> "<message>" [--no-reset] [--json]
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { getProfile } from "./profiles.mjs";

const DB_PATH = process.env.OPENCLAW_TEST_CAPTURE_DB ?? "/root/.openclaw/test-capture/capture.sqlite";
const WEBHOOK_PORT = Number(process.env.OPENCLAW_ZOOM_WEBHOOK_PORT ?? 4000);
// Quiescence must outlast the longest intra-turn gap (comfort → spoke spawn → spoke
// tool calls → announce-back → coordinator relay reply). A short window declares
// "done" inside that gap, disarms mid-turn, and the turn's late records spill into the
// next scenario. 12s comfortably covers the warm spoke round-trip and guarantees the
// bot is idle before we disarm (so nothing leaks to the channel either).
const QUIESCE_MS = 12_000;
// A cold first message after a container restart spends ~70s loading all extensions
// before processing; tolerate that for first activity. Warm runs see activity in ~3s.
const MAX_WAIT_MS = 180_000;
const FIRST_ACTIVITY_DEADLINE_MS = 95_000;

// Heuristic for "mutating / write-ish" tools (for the read-request-stages-no-write guard).
const MUTATING_RE =
  /(create_|update_|delete_|reset_user_password|set_user_active|approve_access_request|reject_access_request)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function openDb() {
  // Mirror the extension's schema so the harness is bootstrap-independent (can arm a
  // run before the extension has lazily loaded). CREATE ... IF NOT EXISTS is idempotent.
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 4000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      armed_channels TEXT NOT NULL DEFAULT '', active_run_id TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS captured_outbound (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts INTEGER NOT NULL,
      endpoint TEXT NOT NULL, to_jid TEXT NOT NULL, robot_jid TEXT,
      text TEXT NOT NULL, head_text TEXT, reply_to TEXT, reply_main_message_id TEXT, raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tool_trace (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
      agent_id TEXT, channel_id TEXT, session_key TEXT, tool_name TEXT, target_agent_id TEXT, params_json TEXT
    );
  `);
  db.prepare(`INSERT OR IGNORE INTO control (id, armed_channels, active_run_id, updated_at) VALUES (1, '', NULL, ?)`).run(Date.now());
  return db;
}

function arm(db, channelJid, runId) {
  db.prepare(`UPDATE control SET armed_channels = ?, active_run_id = ?, updated_at = ? WHERE id = 1`).run(
    channelJid,
    runId,
    Date.now(),
  );
}
function disarm(db) {
  db.prepare(`UPDATE control SET armed_channels = '', active_run_id = NULL, updated_at = ? WHERE id = 1`).run(
    Date.now(),
  );
}
function counts(db, runId) {
  const o = db.prepare(`SELECT COUNT(*) c FROM captured_outbound WHERE run_id = ?`).get(runId).c;
  const t = db.prepare(`SELECT COUNT(*) c FROM tool_trace WHERE run_id = ?`).get(runId).c;
  return o + t;
}
function readOutbound(db, runId) {
  return db
    .prepare(`SELECT ts, endpoint, to_jid, robot_jid, text, head_text, reply_to, reply_main_message_id
              FROM captured_outbound WHERE run_id = ? ORDER BY ts`)
    .all(runId);
}
function readTrace(db, runId) {
  return db
    .prepare(`SELECT ts, kind, agent_id, channel_id, session_key, tool_name, target_agent_id, params_json
              FROM tool_trace WHERE run_id = ? ORDER BY ts`)
    .all(runId);
}

function sign(secret, ts, rawBody) {
  return "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");
}

export function inject(profile, message) {
  const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || "";
  if (!secret) throw new Error("ZOOM_WEBHOOK_SECRET_TOKEN not in env");
  const ts = String(Date.now());
  const mid = "{TEST-" + crypto.randomUUID().toUpperCase() + "}";
  const body = {
    event: "team_chat.channel_message_posted",
    event_ts: Date.now(),
    payload: {
      account_id: "TESTACC",
      operator: profile.operator,
      operator_id: "TESTOPER",
      by_external_user: false,
      object: {
        channel_id: profile.channelIdRaw,
        channel_name: "test",
        date_time: new Date().toISOString(),
        from: "team_chat",
        message,
        session_id: "testsession",
        timestamp: Date.now(),
        message_id: mid,
        reply_main_message_id: mid,
      },
    },
  };
  const raw = JSON.stringify(body);
  const sig = sign(secret, ts, raw);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: WEBHOOK_PORT,
        path: "/zoom/webhook",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
          "x-zm-signature": sig,
          "x-zm-request-timestamp": ts,
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d, messageId: mid }));
      },
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

export async function resetSession(sessionKey) {
  // Reset clears contaminated history. The CLI hangs on teardown but the reset
  // completes server-side; spawn detached and give it a moment.
  const child = spawn(
    "node",
    ["dist/entry.js", "agent", "--session-key", sessionKey, "--message", "/reset"],
    { cwd: "/app", detached: true, stdio: "ignore" },
  );
  child.unref();
  await sleep(4500);
}

async function pollQuiescent(db, runId) {
  const start = Date.now();
  let last = 0;
  let lastChange = Date.now();
  let sawActivity = false;
  for (;;) {
    await sleep(1000);
    const c = counts(db, runId);
    if (c > last) {
      last = c;
      lastChange = Date.now();
      sawActivity = true;
    }
    const now = Date.now();
    if (sawActivity && now - lastChange > QUIESCE_MS) return { quiescent: true, rows: c };
    if (!sawActivity && now - start > FIRST_ACTIVITY_DEADLINE_MS)
      return { quiescent: false, rows: c, reason: "no activity" };
    if (now - start > MAX_WAIT_MS) return { quiescent: false, rows: c, reason: "max wait" };
  }
}

export function summarize(profile, outbound, trace) {
  const toolCalls = trace.filter((r) => r.kind === "tool_call");
  const routedSpokes = [
    ...new Set(toolCalls.filter((r) => r.tool_name === "sessions_spawn" && r.target_agent_id).map((r) => r.target_agent_id)),
  ];
  const coordinatorTools = [
    ...new Set(toolCalls.filter((r) => r.agent_id === profile.agentId).map((r) => r.tool_name)),
  ];
  const nonRouterCoordinatorTools = coordinatorTools.filter(
    (t) => t && !profile.routerTools.includes(t),
  );
  const spokeTools = {};
  for (const r of toolCalls) {
    if (!r.agent_id || r.agent_id === profile.agentId) continue;
    (spokeTools[r.agent_id] ??= []).push(r.tool_name);
  }
  const mutatingToolsCalled = [
    ...new Set(toolCalls.filter((r) => r.tool_name && MUTATING_RE.test(r.tool_name)).map((r) => r.tool_name)),
  ];
  const outboundWithCode = outbound.filter((o) => /CONFIRM\s+\d{4}/i.test(o.text || ""));
  const confirmPrompts = outboundWithCode.filter((o) => /⚠️\s*Confirm|Reply `?CONFIRM/i.test(o.text || ""));
  const threadedOutbound = outbound.filter((o) => o.reply_to || o.reply_main_message_id);
  return {
    routedSpokes,
    coordinatorTools,
    nonRouterCoordinatorTools,
    spokeTools,
    mutatingToolsCalled,
    outboundCount: outbound.length,
    outboundWithCodeCount: outboundWithCode.length,
    confirmPromptCount: confirmPrompts.length,
    threadedOutboundCount: threadedOutbound.length,
    coordinatorSpawned: toolCalls.some((r) => r.tool_name === "sessions_spawn"),
  };
}

export async function runScenario({ profileName, message, reset = true }) {
  const profile = getProfile(profileName);
  const db = openDb();
  const runId = crypto.randomUUID();
  arm(db, profile.channelJid, runId);
  try {
    if (reset) await resetSession(profile.sessionKey);
    const injected = await inject(profile, message);
    const wait = await pollQuiescent(db, runId);
    const outbound = readOutbound(db, runId);
    const trace = readTrace(db, runId);
    return { runId, profile: profileName, message, injected, wait, outbound, trace, summary: summarize(profile, outbound, trace) };
  } finally {
    disarm(db);
    db.close();
  }
}

// ---- CLI ----
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  const [profileName, message] = positional;
  if (!profileName || !message) {
    console.error('usage: node harness.mjs <profile> "<message>" [--no-reset] [--json]');
    process.exit(2);
  }
  const result = await runScenario({ profileName, message, reset: !flags.has("--no-reset") });
  if (flags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n=== scenario: ${result.profile} :: "${result.message}" (run ${result.runId}) ===`);
    console.log("wait:", result.wait);
    console.log("\nSUMMARY:", JSON.stringify(result.summary, null, 2));
    console.log("\nOUTBOUND (captured, NOT sent to channel):");
    for (const o of result.outbound)
      console.log(`  [${o.reply_to ? "threaded" : "root"}] ${JSON.stringify((o.text || "").slice(0, 160))}`);
    console.log("\nTOOL TRACE:");
    for (const t of result.trace)
      console.log(`  ${t.kind} agent=${t.agent_id} tool=${t.tool_name ?? "-"}${t.target_agent_id ? " → " + t.target_agent_id : ""}`);
  }
}
