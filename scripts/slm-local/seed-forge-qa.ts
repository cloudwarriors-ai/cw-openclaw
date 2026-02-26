import fs from "node:fs/promises";
import path from "node:path";
import {
  extractApprovedReviewEventsFromForge,
  type ForgeQaExtractionResult,
} from "../../extensions/slm-pipeline/src/forge-qa-extract.js";

type CliOptions = {
  forgeDir: string;
  outPath: string;
  tenantId: string;
  maxPairs: number;
  maxFiles: number;
  channelNamePattern?: string;
};

const options = parseCliArgs(process.argv.slice(2));
const result = await extractApprovedReviewEventsFromForge({
  forgeDir: options.forgeDir,
  tenantId: options.tenantId,
  maxPairs: options.maxPairs,
  maxFiles: options.maxFiles,
  channelNamePattern: options.channelNamePattern,
});

if (result.events.length === 0) {
  throw new Error(
    `no Q/A pairs were extracted from forge directory: ${options.forgeDir}. ` +
      "Adjust --channel-pattern, --max-files, or check forge outputs.",
  );
}

await fs.mkdir(path.dirname(options.outPath), { recursive: true });
await fs.writeFile(options.outPath, serializeEvents(result), "utf8");

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      out_path: options.outPath,
      tenant_id: options.tenantId,
      extracted_events: result.events.length,
      scanned_files: result.scanned_files,
      scanned_messages: result.scanned_messages,
      extracted_pairs: result.extracted_pairs,
      deduped_pairs: result.deduped_pairs,
    },
    null,
    2,
  )}\n`,
);

function serializeEvents(result: ForgeQaExtractionResult): string {
  return `${result.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function parseCliArgs(argv: string[]): CliOptions {
  const outPathDefault = path.join(process.cwd(), ".data", "slm-local", "zoom-review-events.jsonl");
  let forgeDir =
    process.env.OPENCLAW_SLM_FORGE_WORKSPACE_DIR?.trim() ||
    process.env.FORGE_DIR?.trim() ||
    "/Users/chadsimon/code/forge";
  let outPath = process.env.SLM_QA_EVENTS_OUT?.trim() || outPathDefault;
  let tenantId =
    process.env.SLM_TEST_TENANT?.trim() ||
    process.env.OPENCLAW_MEMORY_SERVER_TENANT?.trim() ||
    "tenant-local";
  let maxPairs = parsePositiveInt(process.env.SLM_SEED_MAX_PAIRS, 50);
  let maxFiles = parsePositiveInt(process.env.SLM_SEED_MAX_FILES, 1200);
  let channelNamePattern = process.env.SLM_SEED_CHANNEL_PATTERN?.trim() || undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--forge-dir") {
      forgeDir = requireArgValue("--forge-dir", argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--out") {
      outPath = requireArgValue("--out", argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--tenant") {
      tenantId = requireArgValue("--tenant", argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--limit") {
      maxPairs = parsePositiveInt(requireArgValue("--limit", argv[i + 1]), maxPairs);
      i += 1;
      continue;
    }
    if (arg === "--max-files") {
      maxFiles = parsePositiveInt(requireArgValue("--max-files", argv[i + 1]), maxFiles);
      i += 1;
      continue;
    }
    if (arg === "--channel-pattern") {
      channelNamePattern = requireArgValue("--channel-pattern", argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  const trimmedForgeDir = forgeDir.trim();
  const trimmedOutPath = outPath.trim();
  const trimmedTenantId = tenantId.trim();
  if (!trimmedForgeDir) {
    throw new Error("forge directory is required");
  }
  if (!trimmedOutPath) {
    throw new Error("output path is required");
  }
  if (!trimmedTenantId) {
    throw new Error("tenant id is required");
  }

  return {
    forgeDir: path.resolve(trimmedForgeDir),
    outPath: path.resolve(trimmedOutPath),
    tenantId: trimmedTenantId,
    maxPairs,
    maxFiles,
    channelNamePattern,
  };
}

function requireArgValue(flag: string, next: string | undefined): string {
  const value = (next ?? "").trim();
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function printUsage(): void {
  process.stdout.write(`Usage:
  bun scripts/slm-local/seed-forge-qa.ts [options]

Options:
  --forge-dir <path>         Forge workspace root (default: /Users/chadsimon/code/forge)
  --out <path>               Output review events jsonl path
  --tenant <tenant-id>       Target tenant id for emitted qa.approved events
  --limit <n>                Max deduped events to emit (default: 50)
  --max-files <n>            Max forge channel files to scan (default: 1200)
  --channel-pattern <regex>  Optional case-insensitive channel_name filter
  -h, --help                 Show this help
`);
}
