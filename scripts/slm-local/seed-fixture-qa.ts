import fs from "node:fs/promises";
import path from "node:path";

type FixtureReviewEvent = {
  event_id: string;
  tenant_id: string;
  trace_id: string;
  event_type: "qa.approved";
  created_at: string;
  input_hash: string;
  output_hash: string;
  ref_id?: string;
  actor_id?: string;
  actor_name?: string;
  source_channel_jid?: string;
  question: string;
  answer: string;
  metadata?: Record<string, unknown>;
};

type CliOptions = {
  fixturePath: string;
  outPath: string;
  tenantId: string;
  limit: number;
};

const options = parseCliArgs(process.argv.slice(2));
const raw = await fs.readFile(options.fixturePath, "utf8");
const events = raw
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => parseFixtureEvent(line))
  .filter((event): event is FixtureReviewEvent => event !== null)
  .slice(0, options.limit)
  .map((event) => ({
    ...event,
    tenant_id: options.tenantId,
  }));

if (events.length === 0) {
  throw new Error(`fixture does not contain valid events: ${options.fixturePath}`);
}

await fs.mkdir(path.dirname(options.outPath), { recursive: true });
await fs.writeFile(
  options.outPath,
  `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  "utf8",
);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      source: "fixture",
      fixture_path: options.fixturePath,
      out_path: options.outPath,
      tenant_id: options.tenantId,
      extracted_events: events.length,
    },
    null,
    2,
  )}\n`,
);

function parseFixtureEvent(line: string): FixtureReviewEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const event = parsed as Record<string, unknown>;
    if (
      typeof event.event_id !== "string" ||
      typeof event.trace_id !== "string" ||
      typeof event.event_type !== "string" ||
      typeof event.created_at !== "string" ||
      typeof event.question !== "string" ||
      typeof event.answer !== "string"
    ) {
      return null;
    }
    if (event.event_type !== "qa.approved") {
      return null;
    }
    return {
      event_id: event.event_id,
      tenant_id:
        typeof event.tenant_id === "string" && event.tenant_id.trim().length > 0
          ? event.tenant_id
          : "tenant-template",
      trace_id: event.trace_id,
      event_type: "qa.approved",
      created_at: event.created_at,
      input_hash: typeof event.input_hash === "string" ? event.input_hash : "",
      output_hash: typeof event.output_hash === "string" ? event.output_hash : "",
      ref_id: typeof event.ref_id === "string" ? event.ref_id : undefined,
      actor_id: typeof event.actor_id === "string" ? event.actor_id : undefined,
      actor_name: typeof event.actor_name === "string" ? event.actor_name : undefined,
      source_channel_jid:
        typeof event.source_channel_jid === "string" ? event.source_channel_jid : undefined,
      question: event.question,
      answer: event.answer,
      metadata:
        event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
          ? (event.metadata as Record<string, unknown>)
          : undefined,
    };
  } catch {
    return null;
  }
}

function parseCliArgs(argv: string[]): CliOptions {
  const fixtureDefault = path.join(
    process.cwd(),
    "scripts",
    "slm-local",
    "fixtures",
    "zoom-review-events.jsonl",
  );
  const outDefault = path.join(process.cwd(), ".data", "slm-local", "zoom-review-events.jsonl");
  let fixturePath = process.env.SLM_QA_FIXTURE_PATH?.trim() || fixtureDefault;
  let outPath = process.env.SLM_QA_EVENTS_OUT?.trim() || outDefault;
  let tenantId = process.env.SLM_TEST_TENANT?.trim() || "tenant-local";
  let limit = parsePositiveInt(process.env.SLM_SEED_MAX_PAIRS, 50);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--fixture") {
      fixturePath = requireArgValue(arg, argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--out") {
      outPath = requireArgValue(arg, argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--tenant") {
      tenantId = requireArgValue(arg, argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--limit") {
      limit = parsePositiveInt(requireArgValue(arg, argv[i + 1]), limit);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return {
    fixturePath: path.resolve(fixturePath),
    outPath: path.resolve(outPath),
    tenantId,
    limit,
  };
}

function requireArgValue(flag: string, value: string | undefined): string {
  const out = (value ?? "").trim();
  if (!out) {
    throw new Error(`${flag} requires a value`);
  }
  return out;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function printUsage(): void {
  process.stdout.write(`Usage:
  bun scripts/slm-local/seed-fixture-qa.ts [options]

Options:
  --fixture <path>           Fixture JSONL file
  --out <path>               Output JSONL file
  --tenant <tenant-id>       Tenant id for emitted events
  --limit <n>                Max events to emit
  -h, --help                 Show help
`);
}
