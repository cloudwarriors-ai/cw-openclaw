import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type VerifyMode = "zoom_api" | "container_logs";

type Scenario = {
  id: string;
  prompt: string;
  assertContainsAll?: string[];
  assertNotContains?: string[];
  judgeCriteria?: string;
  timeoutMs?: number;
};

type ZoomHarnessConfig = {
  userToken: string;
  userId: string;
  toChannel?: string;
  toContact?: string;
  actorHint?: string;
  botHint?: string;
  pollMs: number;
  timeoutMs: number;
  settleMs: number;
  zoomApiBase: string;
  judgeApiBase?: string;
  judgeApiKey?: string;
  judgeModel?: string;
  verifyMode: VerifyMode;
  logsContainer: string;
  logsPollMs: number;
};

type ZoomMessage = {
  id?: string;
  message?: string;
  sender?: string;
  date_time?: string;
  timestamp?: number;
  sender_jid?: string;
  sender_member_id?: string;
};

type ScenarioResult = {
  id: string;
  ok: boolean;
  reason: string;
  replyText?: string;
  replyId?: string;
  durationMs: number;
};

type JudgeResult = {
  pass: boolean;
  reason: string;
};

function parseArgs(argv: string[]) {
  let scenariosPath = "scripts/test-zoom-pulsebot.scenarios.json";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scenarios" && argv[i + 1]) {
      scenariosPath = argv[i + 1];
      i += 1;
    }
  }
  return { scenariosPath };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optionalInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadConfig(): ZoomHarnessConfig {
  const toChannel = process.env.ZOOM_HARNESS_TO_CHANNEL?.trim();
  const toContact = process.env.ZOOM_HARNESS_TO_CONTACT?.trim();
  if (!toChannel && !toContact) {
    throw new Error("Set either ZOOM_HARNESS_TO_CHANNEL or ZOOM_HARNESS_TO_CONTACT.");
  }
  if (toChannel && toContact) {
    throw new Error("Set only one of ZOOM_HARNESS_TO_CHANNEL or ZOOM_HARNESS_TO_CONTACT.");
  }

  const verifyModeRaw = process.env.ZOOM_HARNESS_VERIFY_MODE?.trim().toLowerCase();
  const verifyMode: VerifyMode = verifyModeRaw === "container_logs" ? "container_logs" : "zoom_api";

  return {
    userToken: requiredEnv("ZOOM_HARNESS_USER_TOKEN"),
    userId: process.env.ZOOM_HARNESS_USER_ID?.trim() || "me",
    toChannel,
    toContact,
    actorHint: process.env.ZOOM_HARNESS_ACTOR_HINT?.trim(),
    botHint: process.env.ZOOM_HARNESS_BOT_HINT?.trim(),
    pollMs: optionalInt(process.env.ZOOM_HARNESS_POLL_MS, 2500),
    timeoutMs: optionalInt(process.env.ZOOM_HARNESS_TIMEOUT_MS, 120000),
    settleMs: optionalInt(process.env.ZOOM_HARNESS_SETTLE_MS, 3000),
    zoomApiBase: process.env.ZOOM_HARNESS_ZOOM_API_BASE?.trim() || "https://api.zoom.us/v2",
    judgeApiBase: process.env.ZOOM_HARNESS_JUDGE_API_BASE?.trim(),
    judgeApiKey: process.env.ZOOM_HARNESS_JUDGE_API_KEY?.trim(),
    judgeModel: process.env.ZOOM_HARNESS_JUDGE_MODEL?.trim(),
    verifyMode,
    logsContainer: process.env.ZOOM_HARNESS_LOGS_CONTAINER?.trim() || "openclaw",
    logsPollMs: optionalInt(process.env.ZOOM_HARNESS_LOGS_POLL_MS, 2500),
  };
}

function ensureScenarioShape(input: unknown): Scenario[] {
  if (!Array.isArray(input)) {
    throw new Error("Scenario file must be a JSON array.");
  }
  const scenarios: Scenario[] = [];
  for (const row of input) {
    if (!row || typeof row !== "object") continue;
    const candidate = row as Record<string, unknown>;
    const id = String(candidate.id ?? "").trim();
    const prompt = String(candidate.prompt ?? "").trim();
    if (!id || !prompt) continue;
    scenarios.push({
      id,
      prompt,
      assertContainsAll: Array.isArray(candidate.assertContainsAll)
        ? candidate.assertContainsAll.map((v) => String(v))
        : undefined,
      assertNotContains: Array.isArray(candidate.assertNotContains)
        ? candidate.assertNotContains.map((v) => String(v))
        : undefined,
      judgeCriteria: typeof candidate.judgeCriteria === "string" ? candidate.judgeCriteria : undefined,
      timeoutMs:
        typeof candidate.timeoutMs === "number" && Number.isFinite(candidate.timeoutMs)
          ? Math.max(1000, Math.floor(candidate.timeoutMs))
          : undefined,
    });
  }
  return scenarios;
}

async function loadScenarios(filePath: string): Promise<Scenario[]> {
  const resolved = path.resolve(filePath);
  const raw = await fs.readFile(resolved, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const scenarios = ensureScenarioShape(parsed);
  if (scenarios.length === 0) {
    throw new Error(`No valid scenarios found in ${resolved}`);
  }
  return scenarios;
}

async function zoomUserFetch<T>(
  cfg: ZoomHarnessConfig,
  endpoint: string,
  opts: {
    method?: "GET" | "POST";
    params?: URLSearchParams;
    body?: Record<string, unknown>;
  } = {},
): Promise<T> {
  const url = new URL(`${cfg.zoomApiBase}${endpoint}`);
  if (opts.params) {
    url.search = opts.params.toString();
  }
  const response = await fetch(url.toString(), {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${cfg.userToken}`,
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Zoom API ${response.status}: ${text || "request failed"}`);
  }
  return (await response.json()) as T;
}

async function postUserMessage(cfg: ZoomHarnessConfig, prompt: string): Promise<{ messageId?: string; sentAt: number }> {
  const body: Record<string, unknown> = { message: prompt };
  if (cfg.toChannel) body.to_channel = cfg.toChannel;
  if (cfg.toContact) body.to_contact = cfg.toContact;

  const response = await zoomUserFetch<Record<string, unknown>>(
    cfg,
    `/chat/users/${encodeURIComponent(cfg.userId)}/messages`,
    { method: "POST", body },
  );

  const messageId = asString(response.id) || asString(response.message_id);
  return { messageId, sentAt: Date.now() };
}

async function listConversationMessages(cfg: ZoomHarnessConfig): Promise<ZoomMessage[]> {
  const params = new URLSearchParams({ page_size: "50" });
  if (cfg.toChannel) params.set("to_channel", cfg.toChannel);
  if (cfg.toContact) params.set("to_contact", cfg.toContact);

  const response = await zoomUserFetch<{ messages?: ZoomMessage[] }>(
    cfg,
    `/chat/users/${encodeURIComponent(cfg.userId)}/messages`,
    { method: "GET", params },
  );
  return response.messages ?? [];
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeLower(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

function messageTsMs(message: ZoomMessage): number {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    // Zoom may return seconds or ms; convert to ms if needed.
    return message.timestamp > 1_000_000_000_000 ? message.timestamp : message.timestamp * 1000;
  }
  if (message.date_time) {
    const parsed = Date.parse(message.date_time);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isLikelyBotMessage(cfg: ZoomHarnessConfig, message: ZoomMessage): boolean {
  const senderComposite = [
    message.sender,
    message.sender_jid,
    message.sender_member_id,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (cfg.botHint) {
    return senderComposite.includes(cfg.botHint.toLowerCase());
  }
  if (cfg.actorHint) {
    return !senderComposite.includes(cfg.actorHint.toLowerCase());
  }
  return true;
}

function evaluateAssertions(scenario: Scenario, replyText: string): { ok: boolean; reason: string } {
  const normalized = normalizeLower(replyText);
  for (const needle of scenario.assertContainsAll ?? []) {
    if (!normalized.includes(normalizeLower(needle))) {
      return { ok: false, reason: `missing expected text: "${needle}"` };
    }
  }
  for (const needle of scenario.assertNotContains ?? []) {
    if (normalized.includes(normalizeLower(needle))) {
      return { ok: false, reason: `found forbidden text: "${needle}"` };
    }
  }
  return { ok: true, reason: "assertions passed" };
}

async function judgeWithInference(
  cfg: ZoomHarnessConfig,
  scenario: Scenario,
  replyText: string,
): Promise<JudgeResult | null> {
  if (!scenario.judgeCriteria) return null;
  if (!cfg.judgeApiKey || !cfg.judgeModel) return null;

  const base = cfg.judgeApiBase?.trim() || "https://api.openai.com/v1";
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.judgeApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.judgeModel,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a strict test judge. Return JSON only: {\"pass\": boolean, \"reason\": string}.",
        },
        {
          role: "user",
          content: [
            `Scenario ID: ${scenario.id}`,
            `Criteria: ${scenario.judgeCriteria}`,
            `Candidate response:`,
            replyText,
          ].join("\n\n"),
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Judge API ${response.status}: ${text || "request failed"}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Judge returned empty content.");
  }
  const parsed = JSON.parse(content) as { pass?: boolean; reason?: string };
  return {
    pass: parsed.pass === true,
    reason: parsed.reason?.trim() || "no reason provided",
  };
}

async function waitForReply(
  cfg: ZoomHarnessConfig,
  sentAt: number,
  sentMessageId: string | undefined,
  timeoutMs: number,
): Promise<ZoomMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await listConversationMessages(cfg);
    const candidates = messages
      .filter((message) => {
        if (!message.message?.trim()) return false;
        const ts = messageTsMs(message);
        if (ts && ts < sentAt - 1000) return false;
        if (sentMessageId && message.id === sentMessageId) return false;
        return isLikelyBotMessage(cfg, message);
      })
      .sort((a, b) => messageTsMs(b) - messageTsMs(a));

    if (candidates.length > 0) {
      return candidates[0];
    }
    await new Promise((resolve) => setTimeout(resolve, cfg.pollMs));
  }
  return null;
}

async function containerRuntimeLogsSince(container: string, sinceIso: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["logs", "--tail", "800", "--since", sinceIso, container],
      {
      maxBuffer: 20 * 1024 * 1024,
      },
    );
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read docker runtime logs from ${container}: ${message}`);
  }
}

async function containerSessionLogTail(container: string, logDate: string): Promise<string> {
  const logPath = `/tmp/openclaw/openclaw-${logDate}.log`;
  const command = `if [ -f ${logPath} ]; then tail -n 4000 ${logPath}; fi`;

  try {
    const { stdout, stderr } = await execFileAsync("docker", ["exec", container, "sh", "-lc", command], {
      maxBuffer: 30 * 1024 * 1024,
    });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read container session log ${logPath}: ${message}`);
  }
}

function promptAppearsInLogs(logs: string, prompt: string): boolean {
  const normalizedLogs = logs.toLowerCase();
  const rawPrompt = prompt.toLowerCase();
  const escapedPrompt = JSON.stringify(prompt).slice(1, -1).toLowerCase();
  return normalizedLogs.includes(rawPrompt) || normalizedLogs.includes(escapedPrompt);
}

async function waitForContainerLogEvidence(
  cfg: ZoomHarnessConfig,
  scenario: Scenario,
  sentAt: number,
  timeoutMs: number,
): Promise<{ ok: boolean; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  const sinceIso = new Date(Math.max(0, sentAt - 2000)).toISOString();
  const logDate = new Date(sentAt).toISOString().slice(0, 10);

  while (Date.now() < deadline) {
    const [sessionLogs, runtimeLogs] = await Promise.all([
      containerSessionLogTail(cfg.logsContainer, logDate),
      containerRuntimeLogsSince(cfg.logsContainer, sinceIso),
    ]);
    const logs = `${sessionLogs}\n${runtimeLogs}`;
    const normalizedLogs = logs.toLowerCase();

    if (normalizedLogs.includes("gh: not found")) {
      return { ok: false, reason: "container logs show gh: not found after send" };
    }

    const incomingSeen =
      (normalizedLogs.includes("team_chat payload") && promptAppearsInLogs(normalizedLogs, scenario.prompt)) ||
      normalizedLogs.includes("embedded run start") ||
      normalizedLogs.includes("before_tool_call hook fired");
    const outboundSeen = normalizedLogs.includes("sent message") || normalizedLogs.includes("delivered ");

    if (incomingSeen && outboundSeen) {
      return { ok: true, reason: "webhook payload + outbound delivery confirmed from container logs" };
    }

    await new Promise((resolve) => setTimeout(resolve, cfg.logsPollMs));
  }

  return {
    ok: false,
    reason: `no webhook+delivery log evidence within ${timeoutMs}ms`,
  };
}

async function runScenario(cfg: ZoomHarnessConfig, scenario: Scenario): Promise<ScenarioResult> {
  const started = Date.now();
  const timeoutMs = scenario.timeoutMs ?? cfg.timeoutMs;
  try {
    const sent = await postUserMessage(cfg, scenario.prompt);
    await new Promise((resolve) => setTimeout(resolve, cfg.settleMs));

    if (cfg.verifyMode === "container_logs") {
      const evidence = await waitForContainerLogEvidence(cfg, scenario, sent.sentAt, timeoutMs);
      return {
        id: scenario.id,
        ok: evidence.ok,
        reason: evidence.reason,
        durationMs: Date.now() - started,
      };
    }

    const reply = await waitForReply(cfg, sent.sentAt, sent.messageId, timeoutMs);
    if (!reply?.message) {
      return {
        id: scenario.id,
        ok: false,
        reason: `no bot reply within ${timeoutMs}ms`,
        durationMs: Date.now() - started,
      };
    }

    const assertionResult = evaluateAssertions(scenario, reply.message);
    if (!assertionResult.ok) {
      return {
        id: scenario.id,
        ok: false,
        reason: assertionResult.reason,
        replyText: reply.message,
        replyId: reply.id,
        durationMs: Date.now() - started,
      };
    }

    const judge = await judgeWithInference(cfg, scenario, reply.message);
    if (judge && !judge.pass) {
      return {
        id: scenario.id,
        ok: false,
        reason: `judge failed: ${judge.reason}`,
        replyText: reply.message,
        replyId: reply.id,
        durationMs: Date.now() - started,
      };
    }

    const reason = judge ? `pass (${judge.reason})` : "pass";
    return {
      id: scenario.id,
      ok: true,
      reason,
      replyText: reply.message,
      replyId: reply.id,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      id: scenario.id,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  }
}

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const { scenariosPath } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const scenarios = await loadScenarios(scenariosPath);

  console.log(`Loaded ${scenarios.length} scenario(s) from ${path.resolve(scenariosPath)}`);
  console.log(
    `Target: ${cfg.toChannel ? `channel:${cfg.toChannel}` : `contact:${cfg.toContact}`}; user=${cfg.userId}`,
  );
  console.log(`Verification mode: ${cfg.verifyMode}`);
  if (cfg.verifyMode === "container_logs") {
    console.log(`Container logs source: ${cfg.logsContainer}`);
  }
  if (cfg.judgeApiKey && cfg.judgeModel) {
    console.log(`Inference judge enabled (model=${cfg.judgeModel})`);
  } else {
    console.log("Inference judge disabled (set ZOOM_HARNESS_JUDGE_API_KEY + ZOOM_HARNESS_JUDGE_MODEL to enable)");
  }

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    console.log(`\n[${scenario.id}] sending prompt...`);
    const result = await runScenario(cfg, scenario);
    results.push(result);
    console.log(
      `[${scenario.id}] ${result.ok ? "PASS" : "FAIL"} in ${formatMs(result.durationMs)} :: ${result.reason}`,
    );
    if (result.replyId) {
      console.log(`[${scenario.id}] replyId=${result.replyId}`);
    }
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  console.log(`\nSummary: ${passed}/${results.length} passed, ${failed} failed`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

await main();
