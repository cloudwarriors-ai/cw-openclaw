// Stakeholder extraction and metadata block management for ZoomWarriors support issues

const BLOCK_START = "<!-- zws:stakeholders:start -->";
const BLOCK_END = "<!-- zws:stakeholders:end -->";

type GhIssueLike = {
  body?: string;
  assignees?: Array<{ login?: string }>;
  comments?: Array<{ body?: string }>;
};

export function extractStakeholdersFromIssue(issue: GhIssueLike): {
  reporter: string | undefined;
  stakeholders: string[];
} {
  const all = new Set<string>();
  let reporter: string | undefined;

  const texts = [issue.body ?? "", ...(issue.comments ?? []).map((c) => c.body ?? "")];
  for (const text of texts) {
    const block = extractBlock(text);
    if (block) {
      const reporterMatch = block.match(/Reporter:\s*(.+)/i);
      if (reporterMatch && !reporter) reporter = reporterMatch[1].trim();
      const stakeholderMatch = block.match(/Stakeholders:\s*(.+)/i);
      if (stakeholderMatch) {
        for (const s of stakeholderMatch[1].split(",")) {
          const trimmed = s.trim();
          if (trimmed) all.add(trimmed);
        }
      }
    }
    // Extract @mentions and emails from free text
    for (const match of text.matchAll(/@[\w-]+/g)) all.add(match[0]);
    for (const match of text.matchAll(/[\w.+-]+@[\w.-]+\.\w+/g)) all.add(match[0]);
  }

  // Add assignees
  for (const a of issue.assignees ?? []) {
    if (a.login) all.add(`@${a.login}`);
  }

  return { reporter, stakeholders: [...all] };
}

function extractBlock(text: string): string | null {
  const startIdx = text.indexOf(BLOCK_START);
  const endIdx = text.indexOf(BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  return text.slice(startIdx + BLOCK_START.length, endIdx).trim();
}

export function formatStakeholderBlock(meta: {
  reporter?: string;
  stakeholders?: string[];
}): string {
  const lines = [BLOCK_START];
  if (meta.reporter) lines.push(`Reporter: ${meta.reporter}`);
  if (meta.stakeholders?.length) lines.push(`Stakeholders: ${meta.stakeholders.join(", ")}`);
  lines.push(BLOCK_END);
  return lines.join("\n");
}

export function upsertStakeholderBlock(
  body: string,
  meta: { reporter?: string; stakeholders?: string[] },
): string {
  const block = formatStakeholderBlock(meta);
  const startIdx = body.indexOf(BLOCK_START);
  const endIdx = body.indexOf(BLOCK_END);
  if (startIdx !== -1 && endIdx !== -1) {
    return body.slice(0, startIdx) + block + body.slice(endIdx + BLOCK_END.length);
  }
  return body + "\n\n" + block;
}

export function buildStakeholderWorkPrefix(stakeholders: string[]): string {
  const ghUsers = stakeholders.filter((s) => s.startsWith("@"));
  if (ghUsers.length === 0) return "";
  return `/cc ${ghUsers.join(" ")}`;
}

export function parseIssueNumberFromUrl(url: string): number | undefined {
  const match = url.match(/\/issues\/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export function resolveStakeholderDmTarget(
  stakeholder: string,
  opts: { mapEnv?: string; defaultDomain?: string },
): string | null {
  // If it's already an email or JID, use as-is
  if (stakeholder.includes("@") && !stakeholder.startsWith("@")) return stakeholder;

  const username = stakeholder.replace(/^@/, "");

  // Check stakeholder map env
  if (opts.mapEnv) {
    try {
      const parsed = JSON.parse(opts.mapEnv) as Record<string, string>;
      if (parsed[username]) return parsed[username];
    } catch {
      // Try CSV format: user=email,user2=email2
      for (const pair of opts.mapEnv.split(",")) {
        const [k, v] = pair.split("=");
        if (k?.trim() === username && v?.trim()) return v.trim();
      }
    }
  }

  // Fallback to default domain
  if (opts.defaultDomain) return `${username}@${opts.defaultDomain}`;

  return null;
}
