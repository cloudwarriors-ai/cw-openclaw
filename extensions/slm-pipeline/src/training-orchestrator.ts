import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DatasetArtifact, EvalItem, TrainingRun } from "./types.js";
import {
  ForgeWorkspaceAdapter,
  resolveForgeWorkspaceRootFromEnv,
  type ForgeWorkspaceExport,
} from "./forge-workspace.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;

export type TrainingExecutionResult = {
  ok: boolean;
  adapterPath?: string;
  errorMessage?: string;
  retryable?: boolean;
};

export type TrainingExecutor = {
  run: (params: {
    tenantId: string;
    dataset: DatasetArtifact;
    baseModel: string;
    runId: string;
    attempt: number;
  }) => Promise<TrainingExecutionResult>;
};

export class StubTrainingExecutor implements TrainingExecutor {
  async run(params: {
    tenantId: string;
    dataset: DatasetArtifact;
    baseModel: string;
    runId: string;
    attempt: number;
  }): Promise<TrainingExecutionResult> {
    return {
      ok: true,
      adapterPath: `adapters/${params.tenantId}/${params.runId}/${slugify(params.baseModel)}`,
    };
  }
}

export class ForgeCliTrainingExecutor implements TrainingExecutor {
  constructor(
    private readonly options: {
      bin: string;
      domain: string;
      configPath?: string;
      adapterPath?: string;
      workspaceAdapter?: ForgeWorkspaceAdapter;
      timeoutMs: number;
      runCommand?: (params: { bin: string; args: string[]; timeoutMs: number }) => Promise<{
        code: number;
        stdout: string;
        stderr: string;
      }>;
    },
  ) {}

  async run(params: {
    tenantId: string;
    dataset: DatasetArtifact;
    baseModel: string;
    runId: string;
    attempt: number;
  }): Promise<TrainingExecutionResult> {
    const workspaceExport = await this.exportWorkspace(params);
    const adapterPath = this.options.adapterPath ?? workspaceExport?.adapterPath;
    const args = this.buildArgs({
      tenantId: params.tenantId,
      adapterPath,
    });
    const runCommand = this.options.runCommand ?? runChildProcess;
    const execution = await runCommand({
      bin: this.options.bin,
      args,
      timeoutMs: this.options.timeoutMs,
    });

    if (execution.code === 0) {
      const parsedAdapterPath =
        parseForgeAdapterPath(execution.stdout) ??
        adapterPath ??
        `adapters/${params.tenantId}/${params.runId}/${slugify(params.baseModel)}`;
      return {
        ok: true,
        adapterPath: parsedAdapterPath,
      };
    }

    const message = execution.stderr.trim() || execution.stdout.trim() || "forge command failed";
    return {
      ok: false,
      errorMessage: message,
      retryable: isRetryableFailure(message, execution.code),
    };
  }

  private buildArgs(params: { tenantId: string; adapterPath?: string }): string[] {
    const args = ["train", "--domain", this.options.domain, "--customer-id", params.tenantId];
    if (this.options.configPath) {
      args.push("--config", this.options.configPath);
    }
    if (params.adapterPath) {
      args.push("--adapter-path", params.adapterPath);
    }
    return args;
  }

  private async exportWorkspace(params: {
    tenantId: string;
    dataset: DatasetArtifact;
    runId: string;
  }): Promise<ForgeWorkspaceExport | null> {
    if (!this.options.workspaceAdapter) {
      return null;
    }
    return this.options.workspaceAdapter.exportDataset({
      domain: this.options.domain,
      tenantId: params.tenantId,
      runId: params.runId,
      dataset: params.dataset,
    });
  }
}

export class TrainingOrchestratorService {
  constructor(
    private readonly executor: TrainingExecutor = new StubTrainingExecutor(),
    private readonly maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  ) {}

  async startRun(params: {
    tenantId: string;
    dataset: DatasetArtifact;
    baseModel: string;
    now?: () => Date;
  }): Promise<{
    run: TrainingRun;
    evalItems: EvalItem[];
    attempts: number;
  }> {
    const now = params.now ?? (() => new Date());
    const runId = randomUUID();
    const startedAt = now().toISOString();
    const run: TrainingRun = {
      run_id: runId,
      tenant_id: params.tenantId,
      dataset_id: params.dataset.dataset_id,
      status: "queued",
      started_at: startedAt,
    };

    run.status = "running";
    let attempts = 0;
    let lastFailure = "training failed";
    while (attempts < this.maxAttempts) {
      attempts += 1;
      let result: TrainingExecutionResult;
      try {
        result = await this.executor.run({
          tenantId: params.tenantId,
          dataset: params.dataset,
          baseModel: params.baseModel,
          runId,
          attempt: attempts,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = {
          ok: false,
          errorMessage: message,
          retryable: isRetryableFailure(message, 1),
        };
      }
      if (result.ok) {
        run.status = "succeeded";
        run.ended_at = now().toISOString();
        run.adapter_path = result.adapterPath;
        return {
          run,
          evalItems: createEvalItems({
            runId,
            dataset: params.dataset,
            tenantId: params.tenantId,
          }),
          attempts,
        };
      }

      lastFailure = result.errorMessage ?? "training failed";
      const shouldRetry = Boolean(result.retryable) && attempts < this.maxAttempts;
      if (!shouldRetry) {
        break;
      }
    }

    run.status = "failed";
    run.error_message = lastFailure;
    run.ended_at = now().toISOString();
    return {
      run,
      evalItems: [],
      attempts,
    };
  }
}

export function resolveTrainingExecutorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TrainingExecutor {
  const bin = env.OPENCLAW_SLM_FORGE_BIN?.trim();
  const domain = env.OPENCLAW_SLM_FORGE_DOMAIN?.trim();
  if (!bin || !domain) {
    return new StubTrainingExecutor();
  }

  const timeoutRaw = env.OPENCLAW_SLM_FORGE_TIMEOUT_MS?.trim() ?? "";
  const timeoutMs = Number.parseInt(timeoutRaw, 10);
  const workspaceRoot = resolveForgeWorkspaceRootFromEnv(env);
  return new ForgeCliTrainingExecutor({
    bin,
    domain,
    configPath: optionalTrimmed(env.OPENCLAW_SLM_FORGE_CONFIG_PATH),
    adapterPath: optionalTrimmed(env.OPENCLAW_SLM_FORGE_ADAPTER_PATH),
    workspaceAdapter: workspaceRoot ? new ForgeWorkspaceAdapter(workspaceRoot) : undefined,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  });
}

function createEvalItems(params: {
  runId: string;
  dataset: DatasetArtifact;
  tenantId: string;
}): EvalItem[] {
  const evalSource =
    params.dataset.eval.length > 0 ? params.dataset.eval : params.dataset.train.slice(0, 1);
  return evalSource.map((example) => ({
    item_id: randomUUID(),
    run_id: params.runId,
    tenant_id: params.tenantId,
    prompt: example.input,
    model_answer: "",
    gold_answer: example.target,
    citations: example.citations,
    review_state: "pending" as const,
  }));
}

export function parseForgeAdapterPath(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  const directJson = parseAdapterPathFromJson(trimmed);
  if (directJson) {
    return directJson;
  }

  const lines = trimmed.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const adapterPathFromJson = parseAdapterPathFromJson(line);
    if (adapterPathFromJson) {
      return adapterPathFromJson;
    }
    if (!line.startsWith("ADAPTER_PATH=")) {
      continue;
    }
    const value = line.slice("ADAPTER_PATH=".length).trim();
    if (value) {
      return value;
    }
  }
  return null;
}

async function runChildProcess(params: {
  bin: string;
  args: string[];
  timeoutMs: number;
}): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const proc = spawn(params.bin, params.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({
        code: 124,
        stdout,
        stderr: `${stderr}\ntraining command timed out`,
      });
    }, params.timeoutMs);

    proc.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`,
      });
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function isRetryableFailure(message: string, code: number): boolean {
  if (code === 124) {
    return true;
  }
  const lower = message.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("temporar") ||
    lower.includes("econn") ||
    lower.includes("rate limit") ||
    lower.includes("unavailable")
  );
}

function parseAdapterPathFromJson(candidate: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
  return extractAdapterPath(payload);
}

function extractAdapterPath(payload: unknown, depth: number = 0): string | null {
  if (depth > 5 || !payload || typeof payload !== "object") {
    return null;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractAdapterPath(item, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  const record = payload as Record<string, unknown>;
  const direct = record.adapter_path;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const camel = record.adapterPath;
  if (typeof camel === "string" && camel.trim()) {
    return camel.trim();
  }

  for (const value of Object.values(record)) {
    const nested = extractAdapterPath(value, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}
