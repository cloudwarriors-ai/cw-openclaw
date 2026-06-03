import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PassthroughResult } from "./passthrough-state.js";

/**
 * Executes the Scopely passthrough test suite via Playwright and returns
 * structured results. Designed to be invoked on a schedule by the OpenClaw
 * runner hook.
 *
 * Requires the Scopely repo to be checked out somewhere reachable; the path
 * is configured via the SCOPELY_REPO_PATH env var.
 */

export interface PassthroughRunResult {
  passthrough: string; // extracted from [bracket] in test title
  testTitle: string;
  status: PassthroughResult;
  durationMs: number;
  errorMessage?: string;
}

export interface PassthroughRunSummary {
  startedAt: Date;
  durationMs: number;
  results: PassthroughRunResult[];
  ranSuccessfully: boolean; // false if Playwright itself crashed
  runError?: string; // populated when ranSuccessfully = false
}

const PASSTHROUGH_KEY_RE = /\[([a-z0-9-]+)\]/i;

function extractPassthroughKey(testTitle: string): string {
  const match = testTitle.match(PASSTHROUGH_KEY_RE);
  return match ? match[1] : "unknown";
}

interface PlaywrightJsonResult {
  status?: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration?: number;
  errors?: Array<{ message?: string }>;
  error?: { message?: string };
}

interface PlaywrightJsonTest {
  title: string;
  results?: PlaywrightJsonResult[];
}

interface PlaywrightJsonSpec {
  title: string;
  tests?: PlaywrightJsonTest[];
}

interface PlaywrightJsonSuite {
  title?: string;
  specs?: PlaywrightJsonSpec[];
  suites?: PlaywrightJsonSuite[];
}

interface PlaywrightJsonReport {
  suites?: PlaywrightJsonSuite[];
}

function flattenSuites(
  suite: PlaywrightJsonSuite,
  parentTitle = "",
): Array<{ title: string; result: PlaywrightJsonResult | undefined }> {
  const out: Array<{ title: string; result: PlaywrightJsonResult | undefined }> = [];
  const fullTitle =
    parentTitle && suite.title ? `${parentTitle} › ${suite.title}` : (suite.title ?? parentTitle);

  for (const spec of suite.specs ?? []) {
    const specTitle = fullTitle ? `${fullTitle} › ${spec.title}` : spec.title;
    for (const test of spec.tests ?? []) {
      const lastResult = test.results?.[test.results.length - 1];
      out.push({ title: specTitle, result: lastResult });
    }
  }

  for (const child of suite.suites ?? []) {
    out.push(...flattenSuites(child, fullTitle));
  }

  return out;
}

function normalizeStatus(s: string | undefined): PassthroughResult {
  if (s === "passed") {
    return "passed";
  }
  if (s === "skipped") {
    return "skipped";
  }
  return "failed";
}

function parsePlaywrightJson(json: string): PassthroughRunResult[] {
  const report = JSON.parse(json) as PlaywrightJsonReport;
  const flat: PassthroughRunResult[] = [];
  for (const suite of report.suites ?? []) {
    for (const item of flattenSuites(suite)) {
      const status = normalizeStatus(item.result?.status);
      const errMsg = item.result?.error?.message ?? item.result?.errors?.[0]?.message;
      flat.push({
        passthrough: extractPassthroughKey(item.title),
        testTitle: item.title,
        status,
        durationMs: Math.round(item.result?.duration ?? 0),
        errorMessage: errMsg ? String(errMsg).slice(0, 500) : undefined,
      });
    }
  }
  return flat;
}

/**
 * Run the passthrough test suite. Returns structured results.
 *
 * Required env vars:
 * - SCOPELY_REPO_PATH: absolute path to the Scopely repo (where playwright.config.ts lives)
 *
 * Optional env vars:
 * - SCOPELY_URL, SCOPELY_EMAIL, SCOPELY_PASSWORD: passed through to the test process
 *   (will become E2E_BACKEND_URL, E2E_FRONTEND_URL, E2E_EMAIL, E2E_PASSWORD)
 * - PASSTHROUGH_TEST_TIMEOUT_MS: max wall time for the whole run (default 5 min)
 */
export async function runPassthroughTests(): Promise<PassthroughRunSummary> {
  const startedAt = new Date();
  const start = Date.now();

  const repoPath = process.env.SCOPELY_REPO_PATH;
  if (!repoPath || !fs.existsSync(repoPath)) {
    return {
      startedAt,
      durationMs: 0,
      results: [],
      ranSuccessfully: false,
      runError: `SCOPELY_REPO_PATH not set or directory does not exist: ${repoPath ?? "(unset)"}`,
    };
  }

  const timeoutMs = Number(process.env.PASSTHROUGH_TEST_TIMEOUT_MS ?? 5 * 60 * 1000);
  const tmpFile = path.join(os.tmpdir(), `passthrough-${Date.now()}.json`);

  // Forward SCOPELY_* creds into the E2E_* env the tests expect
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT_JSON_OUTPUT_NAME: tmpFile,
    E2E_BACKEND_URL: process.env.E2E_BACKEND_URL ?? process.env.SCOPELY_URL,
    E2E_FRONTEND_URL: process.env.E2E_FRONTEND_URL ?? process.env.SCOPELY_URL,
    E2E_EMAIL: process.env.E2E_EMAIL ?? process.env.SCOPELY_EMAIL,
    E2E_PASSWORD: process.env.E2E_PASSWORD ?? process.env.SCOPELY_PASSWORD,
  };

  const args = ["playwright", "test", "--project=passthrough", "--reporter=json"];

  const spawnResult = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn("npx", args, {
        cwd: repoPath,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));

      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(killTimer);
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
      child.on("error", (err) => {
        clearTimeout(killTimer);
        resolve({ exitCode: -1, stdout, stderr: stderr + String(err) });
      });
    },
  );

  const durationMs = Date.now() - start;

  // Playwright writes JSON to PLAYWRIGHT_JSON_OUTPUT_NAME if set, else stdout
  let jsonContent = "";
  if (fs.existsSync(tmpFile)) {
    try {
      jsonContent = fs.readFileSync(tmpFile, "utf-8");
      fs.unlinkSync(tmpFile);
    } catch {
      // fall through to stdout
    }
  }
  if (!jsonContent) {
    // Playwright sometimes writes JSON to stdout — try to extract it
    const jsonStart = spawnResult.stdout.indexOf("{");
    if (jsonStart >= 0) {
      jsonContent = spawnResult.stdout.slice(jsonStart);
    }
  }

  if (!jsonContent) {
    return {
      startedAt,
      durationMs,
      results: [],
      ranSuccessfully: false,
      runError: `Playwright produced no JSON output. Exit code: ${spawnResult.exitCode}. Stderr: ${spawnResult.stderr.slice(0, 500)}`,
    };
  }

  let results: PassthroughRunResult[];
  try {
    results = parsePlaywrightJson(jsonContent);
  } catch (err) {
    return {
      startedAt,
      durationMs,
      results: [],
      ranSuccessfully: false,
      runError: `Failed to parse Playwright JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Playwright exits non-zero when tests fail — that's NOT a runner error,
  // it's the expected signal. Only treat unexpected exits as runner errors.
  // If we got results, the runner worked, regardless of pass/fail counts.
  return {
    startedAt,
    durationMs,
    results,
    ranSuccessfully: true,
  };
}
