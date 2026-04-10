const STAKEHOLDER_BLOCK_START = "<!-- eoa:stakeholders:start -->";
const STAKEHOLDER_BLOCK_END = "<!-- eoa:stakeholders:end -->";
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const GH_MENTION_RE = /(^|[^\w])@([a-z0-9](?:-?[a-z0-9]){0,38})(?=$|[^\w-])/gi;

export type StakeholderSet = {
  reporter?: string;
  stakeholders: string[];
};

type IssueCommentLike = { body?: string };
type IssueLike = {
  body?: string;
  assignees?: Array<{ login?: string }>;
  comments?: IssueCommentLike[];
};

export function normalizeStakeholder(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/^mailto:/i, "").replace(/[<>]/g, "").trim();
  if (!cleaned) return null;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleaned)) return cleaned.toLowerCase();
  if (/@xmpp\.zoom\.us$/i.test(cleaned)) return cleaned.toLowerCase();
  if (/^@[a-z0-9](?:-?[a-z0-9]){0,38}$/i.test(cleaned)) return cleaned.toLowerCase();
  if (/^[a-z0-9](?:-?[a-z0-9]){0,38}$/i.test(cleaned)) return `@${cleaned.toLowerCase()}`;
  return cleaned;
}

function uniquePreserveOrder(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeStakeholder(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function parseStakeholderList(raw: string): string[] {
  return uniquePreserveOrder(raw.split(/[,\n]/g).map((token) => token.trim()).filter(Boolean));
}

function extractEmails(text: string): string[] {
  const matches = text.match(EMAIL_RE) ?? [];
  return uniquePreserveOrder(matches);
}

function extractMentions(text: string): string[] {
  const mentions: string[] = [];
  let match: RegExpExecArray | null;
  GH_MENTION_RE.lastIndex = 0;
  while ((match = GH_MENTION_RE.exec(text)) !== null) {
    mentions.push(`@${match[2]}`);
  }
  return uniquePreserveOrder(mentions);
}

export function formatStakeholderBlock(input: StakeholderSet): string {
  const reporter = normalizeStakeholder(input.reporter ?? "") ?? "unknown";
  const stakeholders = uniquePreserveOrder([reporter, ...input.stakeholders]);
  return [
    STAKEHOLDER_BLOCK_START,
    `Reporter: ${reporter}`,
    `Stakeholders: ${stakeholders.join(", ") || "none"}`,
    STAKEHOLDER_BLOCK_END,
  ].join("\n");
}

export function upsertStakeholderBlock(body: string, input: StakeholderSet): string {
  const block = formatStakeholderBlock(input);
  const source = body.trim();
  const blockRe = new RegExp(
    `${escapeForRegex(STAKEHOLDER_BLOCK_START)}[\\s\\S]*?${escapeForRegex(STAKEHOLDER_BLOCK_END)}`,
    "i",
  );
  if (blockRe.test(source)) {
    return source.replace(blockRe, block).trim();
  }
  if (!source) return block;
  return `${source}\n\n${block}`.trim();
}

function parseBlock(text: string): StakeholderSet {
  const out: StakeholderSet = { stakeholders: [] };
  const lines = text.split(/\r?\n/g);
  for (const line of lines) {
    const reporterMatch = line.match(/^\s*Reporter:\s*(.+)\s*$/i);
    if (reporterMatch) {
      out.reporter = normalizeStakeholder(reporterMatch[1]) ?? out.reporter;
      continue;
    }
    const stakeholdersMatch = line.match(/^\s*Stakeholders:\s*(.+)\s*$/i);
    if (stakeholdersMatch) {
      out.stakeholders = uniquePreserveOrder([...out.stakeholders, ...parseStakeholderList(stakeholdersMatch[1])]);
    }
  }
  if (out.reporter) {
    out.stakeholders = uniquePreserveOrder([out.reporter, ...out.stakeholders]);
  }
  return out;
}

function parseStakeholderBlocks(text: string): StakeholderSet {
  const out: StakeholderSet = { stakeholders: [] };
  const blockRe = new RegExp(
    `${escapeForRegex(STAKEHOLDER_BLOCK_START)}([\\s\\S]*?)${escapeForRegex(STAKEHOLDER_BLOCK_END)}`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(text)) !== null) {
    const parsed = parseBlock(match[1] ?? "");
    if (!out.reporter && parsed.reporter) out.reporter = parsed.reporter;
    out.stakeholders = uniquePreserveOrder([...out.stakeholders, ...parsed.stakeholders]);
  }
  return out;
}

function collectFromText(text: string): StakeholderSet {
  const block = parseStakeholderBlocks(text);
  const fallbackReporter = (() => {
    const reporterLine = text.match(/^\s*Reporter:\s*(.+)\s*$/im)?.[1];
    return reporterLine ? normalizeStakeholder(reporterLine) ?? undefined : undefined;
  })();
  const inlineStakeholders = (() => {
    const line = text.match(/^\s*Stakeholders:\s*(.+)\s*$/im)?.[1];
    return line ? parseStakeholderList(line) : [];
  })();
  const discovered = uniquePreserveOrder([
    ...block.stakeholders,
    ...inlineStakeholders,
    ...extractEmails(text),
    ...extractMentions(text),
  ]);
  return {
    reporter: block.reporter ?? fallbackReporter,
    stakeholders: block.reporter
      ? uniquePreserveOrder([block.reporter, ...discovered])
      : discovered,
  };
}

export function extractStakeholdersFromIssue(issue: IssueLike): StakeholderSet {
  const combined: StakeholderSet = { stakeholders: [] };

  const issueBody = typeof issue.body === "string" ? issue.body : "";
  const fromIssue = collectFromText(issueBody);
  combined.reporter = fromIssue.reporter;
  combined.stakeholders = uniquePreserveOrder([...combined.stakeholders, ...fromIssue.stakeholders]);

  for (const assignee of issue.assignees ?? []) {
    const mention = normalizeStakeholder(`@${assignee.login ?? ""}`);
    if (mention) combined.stakeholders = uniquePreserveOrder([...combined.stakeholders, mention]);
  }

  for (const comment of issue.comments ?? []) {
    const body = typeof comment.body === "string" ? comment.body : "";
    const fromComment = collectFromText(body);
    if (!combined.reporter && fromComment.reporter) combined.reporter = fromComment.reporter;
    combined.stakeholders = uniquePreserveOrder([...combined.stakeholders, ...fromComment.stakeholders]);
  }

  if (combined.reporter) {
    combined.stakeholders = uniquePreserveOrder([combined.reporter, ...combined.stakeholders]);
  }
  return combined;
}

export function buildStakeholderWorkPrefix(stakeholders: string[]): string {
  const normalized = uniquePreserveOrder(stakeholders);
  if (normalized.length === 0) return "";
  const mentions = normalized.filter((token) => token.startsWith("@"));
  const lines: string[] = [];
  if (mentions.length > 0) lines.push(`/cc ${mentions.join(" ")}`);
  lines.push(`Stakeholders: ${normalized.join(", ")}`);
  return lines.join("\n");
}

export function parseIssueNumberFromUrl(url: string): number | null {
  const match = url.match(/\/issues\/(\d+)\b/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveStakeholderDmTarget(input: string, params?: {
  mapEnv?: string;
  defaultDomain?: string;
}): string | null {
  const normalized = normalizeStakeholder(input);
  if (!normalized) return null;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return normalized;
  if (/@xmpp\.zoom\.us$/i.test(normalized)) return normalized;

  const username = normalized.startsWith("@") ? normalized.slice(1) : normalized;
  if (!username) return null;

  const explicit = parseStakeholderMap(params?.mapEnv);
  const mapped = explicit.get(username.toLowerCase());
  if (mapped) return mapped;

  const domain = params?.defaultDomain?.trim();
  if (!domain) return null;
  return `${username.toLowerCase()}@${domain.replace(/^@/, "").toLowerCase()}`;
}

export function parseStakeholderMap(raw: string | undefined): Map<string, string> {
  const mapping = new Map<string, string>();
  const source = raw?.trim();
  if (!source) return mapping;

  if (source.startsWith("{")) {
    try {
      const parsed = JSON.parse(source) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        const normalizedValue = normalizeStakeholder(String(value ?? ""));
        const normalizedKey = key.trim().toLowerCase().replace(/^@/, "");
        if (!normalizedKey || !normalizedValue) continue;
        mapping.set(normalizedKey, normalizedValue);
      }
      return mapping;
    } catch {
      // Fall through to CSV format.
    }
  }

  for (const pair of source.split(/[,\n]/g)) {
    const [keyRaw, valueRaw] = pair.split("=");
    const key = keyRaw?.trim().toLowerCase().replace(/^@/, "");
    const value = normalizeStakeholder(valueRaw ?? "");
    if (!key || !value) continue;
    mapping.set(key, value);
  }
  return mapping;
}

function escapeForRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
