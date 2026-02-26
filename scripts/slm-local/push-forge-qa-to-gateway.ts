import {
  extractApprovedReviewEventsFromForge,
} from "../../extensions/slm-pipeline/src/forge-qa-extract.js";
import { GatewayRpcClient } from "../../apps/slm-dashboard/src/server/gateway-client.js";

type CliOptions = {
  forgeDir: string;
  gatewayUrl: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  tenantId: string;
  limit: number;
  maxFiles: number;
  channelPattern?: string;
  dryRun: boolean;
};

const options = parseArgs(process.argv.slice(2));

const extracted = await extractApprovedReviewEventsFromForge({
  forgeDir: options.forgeDir,
  tenantId: options.tenantId,
  maxPairs: options.limit,
  maxFiles: options.maxFiles,
  channelNamePattern: options.channelPattern,
});

if (extracted.events.length === 0) {
  throw new Error(
    `no forge Q/A events found for tenant=${options.tenantId} (forgeDir=${options.forgeDir})`,
  );
}

if (options.dryRun) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        dry_run: true,
        extracted_events: extracted.events.length,
        scanned_files: extracted.scanned_files,
        scanned_messages: extracted.scanned_messages,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const client = new GatewayRpcClient({
  url: options.gatewayUrl,
  token: options.gatewayToken,
  password: options.gatewayPassword,
  timeoutMs: 20_000,
});

const pushedProjectionIds: string[] = [];
for (const event of extracted.events) {
  const question = truncateForGateway(event.question, 4_000);
  const answer = truncateForGateway(event.answer, 12_000);
  const response = await client.request<{ record?: { projection_id?: string } }>(
    "slm.control.qa.update",
    {
      tenant_id: options.tenantId,
      question,
      answer,
      ref_id: event.ref_id,
      source_channel: "zoom",
      source_ref: event.ref_id,
      trace_id: event.trace_id,
    },
  );
  const projectionId = response.record?.projection_id;
  if (projectionId) {
    pushedProjectionIds.push(projectionId);
  }
}

const listed = await client.request<{ records?: Array<{ projection_id?: string }> }>(
  "slm.control.qa.list",
  {
    tenant_id: options.tenantId,
    limit: Math.max(options.limit, 50),
  },
);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      gateway_url: options.gatewayUrl,
      tenant_id: options.tenantId,
      extracted_events: extracted.events.length,
      pushed_records: pushedProjectionIds.length,
      qa_registry_count: Array.isArray(listed.records) ? listed.records.length : 0,
      scanned_files: extracted.scanned_files,
      scanned_messages: extracted.scanned_messages,
    },
    null,
    2,
  )}\n`,
);

function parseArgs(argv: string[]): CliOptions {
  let forgeDir =
    process.env.OPENCLAW_SLM_FORGE_WORKSPACE_DIR?.trim() ||
    process.env.FORGE_DIR?.trim() ||
    "/Users/chadsimon/code/forge";
  let gatewayUrl = process.env.SLM_DASHBOARD_GATEWAY_URL?.trim() || "ws://127.0.0.1:18889";
  let gatewayToken = process.env.SLM_DASHBOARD_GATEWAY_TOKEN?.trim() || undefined;
  let gatewayPassword = process.env.SLM_DASHBOARD_GATEWAY_PASSWORD?.trim() || undefined;
  let tenantId = process.env.SLM_TEST_TENANT?.trim() || "tenant-a";
  let limit = parsePositiveInt(process.env.SLM_SEED_MAX_PAIRS, 40);
  let maxFiles = parsePositiveInt(process.env.SLM_SEED_MAX_FILES, 1200);
  let channelPattern = process.env.SLM_SEED_CHANNEL_PATTERN?.trim() || undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--forge-dir") {
      forgeDir = requireArgValue(arg, argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--gateway-url") {
      gatewayUrl = requireArgValue(arg, argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--gateway-token") {
      gatewayToken = requireArgValue(arg, argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--gateway-password") {
      gatewayPassword = requireArgValue(arg, argv[i + 1]);
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
    if (arg === "--max-files") {
      maxFiles = parsePositiveInt(requireArgValue(arg, argv[i + 1]), maxFiles);
      i += 1;
      continue;
    }
    if (arg === "--channel-pattern") {
      channelPattern = requireArgValue(arg, argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  const trimmedGatewayUrl = gatewayUrl.trim();
  const trimmedTenantId = tenantId.trim();
  if (!trimmedGatewayUrl) {
    throw new Error("gateway url is required");
  }
  if (!trimmedTenantId) {
    throw new Error("tenant is required");
  }

  return {
    forgeDir,
    gatewayUrl: trimmedGatewayUrl,
    gatewayToken,
    gatewayPassword,
    tenantId: trimmedTenantId,
    limit,
    maxFiles,
    channelPattern,
    dryRun,
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

function truncateForGateway(input: string | undefined, max: number): string {
  const trimmed = (input ?? "").trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return trimmed.slice(0, max);
}

function printHelp(): void {
  process.stdout.write(`Usage:
  bun scripts/slm-local/push-forge-qa-to-gateway.ts [options]

Options:
  --forge-dir <path>          Forge workspace root (default: /Users/chadsimon/code/forge)
  --gateway-url <ws-url>      Gateway websocket url (default: ws://127.0.0.1:18889)
  --gateway-token <token>     Gateway token (or use SLM_DASHBOARD_GATEWAY_TOKEN)
  --gateway-password <value>  Gateway password if password auth is enabled
  --tenant <tenant-id>        Tenant id for QA projection writes (default: tenant-a)
  --limit <n>                 Max deduped Q/A pairs to push (default: 40)
  --max-files <n>             Max forge channel files to scan (default: 1200)
  --channel-pattern <regex>   Optional case-insensitive channel_name filter
  --dry-run                   Extract only, do not push to gateway
  -h, --help                  Show help
`);
}
