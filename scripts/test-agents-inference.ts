import fs from "node:fs/promises";
import path from "node:path";

type Scenario = {
  id: string;
  agent: string;
  prompt: string;
  assertContainsAll?: string[];
  assertNotContains?: string[];
  judgeCriteria?: string;
  timeoutMs?: number;
  sessionKey?: string;
};

type InferenceConfig = {
  gatewayUrl: string;
  token: string;
  timeoutMs: number;
  judgeApiBase?: string;
  judgeApiKey?: string;
  judgeModel?: string;
};

type ScenarioResult = {
  id: string;
  agent: string;
  ok: boolean;
  reason: string;
  replyText?: string;
  durationMs: number;
};

type JudgeResult = {
  pass: boolean;
  reason: string;
};

function parseArgs(argv: string[]) {
  let scenariosPath = "scripts/test-agents-inference.scenarios.json";
  let agentFilter: string | undefined;
  let idFilter: string[] | undefined;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scenarios" && argv[i + 1]) {
      scenariosPath = argv[i + 1];
      i += 1;
    } else if (arg === "--agent" && argv[i + 1]) {
      agentFilter = argv[i + 1];
      i += 1;
    } else if (arg === "--id" && argv[i + 1]) {
      idFilter = argv[i + 1].split(",").map((s) => s.trim());
      i += 1;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    }
  }
  return { scenariosPath, agentFilter, idFilter, verbose };
}

function loadConfig(): InferenceConfig {
  const gatewayUrl = process.env.GATEWAY_TEST_URL?.trim() || "http://127.0.0.1:18789";
  const token = process.env.GATEWAY_TEST_TOKEN?.trim() || process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || "dev-token";
  const timeoutMs = optionalInt(process.env.GATEWAY_TEST_TIMEOUT_MS, 120_000);
  return {
    gatewayUrl,
    token,
    timeoutMs,
    judgeApiBase: process.env.GATEWAY_TEST_JUDGE_API_BASE?.trim(),
    judgeApiKey: process.env.GATEWAY_TEST_JUDGE_API_KEY?.trim(),
    judgeModel: process.env.GATEWAY_TEST_JUDGE_MODEL?.trim(),
  };
}

function optionalInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ensureScenarioShape(input: unknown): Scenario[] {
  if (!Array.isArray(input)) {
    throw new Error("Scenario file must be a JSON array.");
  }
  const scenarios: Scenario[] = [];
  for (const row of input) {
    if (!row || typeof row !== "object") continue;
    const c = row as Record<string, unknown>;
    const id = String(c.id ?? "").trim();
    const agent = String(c.agent ?? "").trim();
    const prompt = String(c.prompt ?? "").trim();
    if (!id || !agent || !prompt) continue;
    scenarios.push({
      id,
      agent,
      prompt,
      assertContainsAll: Array.isArray(c.assertContainsAll) ? c.assertContainsAll.map((v) => String(v)) : undefined,
      assertNotContains: Array.isArray(c.assertNotContains) ? c.assertNotContains.map((v) => String(v)) : undefined,
      judgeCriteria: typeof c.judgeCriteria === "string" ? c.judgeCriteria : undefined,
      timeoutMs:
        typeof c.timeoutMs === "number" && Number.isFinite(c.timeoutMs)
          ? Math.max(1000, Math.floor(c.timeoutMs))
          : undefined,
      sessionKey: typeof c.sessionKey === "string" ? c.sessionKey : undefined,
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

function normalizeLower(value: string | undefined): string {
  return (value ?? "").toLowerCase();
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
  cfg: InferenceConfig,
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
          content: 'You are a strict test judge. Return JSON only: {"pass": boolean, "reason": string}.',
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

async function sendGatewayPrompt(
  cfg: InferenceConfig,
  scenario: Scenario,
): Promise<string> {
  const timeoutMs = scenario.timeoutMs ?? cfg.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body: Record<string, unknown> = {
    model: `openclaw:${scenario.agent}`,
    stream: false,
    messages: [{ role: "user", content: scenario.prompt }],
  };
  if (scenario.sessionKey) {
    body.session_key = scenario.sessionKey;
  }

  try {
    const response = await fetch(`${cfg.gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        "X-OpenClaw-Agent-ID": scenario.agent,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Gateway ${response.status}: ${text || "request failed"}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("Gateway returned empty content.");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function runScenario(cfg: InferenceConfig, scenario: Scenario): Promise<ScenarioResult> {
  const started = Date.now();
  try {
    const replyText = await sendGatewayPrompt(cfg, scenario);

    const assertionResult = evaluateAssertions(scenario, replyText);
    if (!assertionResult.ok) {
      return {
        id: scenario.id,
        agent: scenario.agent,
        ok: false,
        reason: assertionResult.reason,
        replyText,
        durationMs: Date.now() - started,
      };
    }

    const judge = await judgeWithInference(cfg, scenario, replyText);
    if (judge && !judge.pass) {
      return {
        id: scenario.id,
        agent: scenario.agent,
        ok: false,
        reason: `judge failed: ${judge.reason}`,
        replyText,
        durationMs: Date.now() - started,
      };
    }

    const reason = judge ? `pass (${judge.reason})` : "pass";
    return {
      id: scenario.id,
      agent: scenario.agent,
      ok: true,
      reason,
      replyText,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: scenario.id,
      agent: scenario.agent,
      ok: false,
      reason: message,
      durationMs: Date.now() - started,
    };
  }
}

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const { scenariosPath, agentFilter, idFilter, verbose } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  let scenarios = await loadScenarios(scenariosPath);

  if (agentFilter) {
    scenarios = scenarios.filter((s) => s.agent === agentFilter);
  }
  if (idFilter) {
    scenarios = scenarios.filter((s) => idFilter.includes(s.id));
  }

  if (scenarios.length === 0) {
    console.error("No scenarios matched filters.");
    process.exitCode = 1;
    return;
  }

  console.log(`Loaded ${scenarios.length} scenario(s) from ${path.resolve(scenariosPath)}`);
  console.log(`Gateway: ${cfg.gatewayUrl}`);
  if (cfg.judgeApiKey && cfg.judgeModel) {
    console.log(`Inference judge enabled (model=${cfg.judgeModel})`);
  } else {
    console.log("Inference judge disabled (set GATEWAY_TEST_JUDGE_API_KEY + GATEWAY_TEST_JUDGE_MODEL to enable)");
  }

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    console.log(`\n[${scenario.id}] agent=${scenario.agent} sending prompt...`);
    const result = await runScenario(cfg, scenario);
    results.push(result);
    console.log(
      `[${scenario.id}] ${result.ok ? "PASS" : "FAIL"} in ${formatMs(result.durationMs)} :: ${result.reason}`,
    );
    if (result.replyText && (verbose || !result.ok)) {
      const preview = result.replyText.length > 200 ? `${result.replyText.slice(0, 200)}...` : result.replyText;
      console.log(`[${scenario.id}] reply: ${preview}`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nSummary: ${passed}/${results.length} passed, ${failed} failed`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

await main();
