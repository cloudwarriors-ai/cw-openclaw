import * as fs from "fs";
import * as path from "path";

export interface AuditEntry {
  ts: string;
  tool: string;
  actor: string;
  trigger?: string;
  params?: Record<string, unknown>;
  resultSummary?: string;
  durationMs?: number;
  error?: string;
}

export function createAuditLogger(workspaceDir: string) {
  const auditDir = path.join(workspaceDir, "scopelybot");
  const auditFile = path.join(auditDir, "audit.jsonl");

  try {
    fs.mkdirSync(auditDir, { recursive: true });
  } catch {
    // ignore if exists
  }

  return function logAudit(entry: AuditEntry) {
    const line = JSON.stringify(entry) + "\n";
    try {
      fs.appendFileSync(auditFile, line);
    } catch (err) {
      console.error("[scopelybot-audit] Failed to write audit log:", err);
    }
  };
}

export type AuditLogger = ReturnType<typeof createAuditLogger>;

export function wrapToolWithAudit(
  toolDef: {
    name: string;
    description: string;
    parameters: unknown;
    execute: (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: { type: "text"; text: string }[] }>;
  },
  logger: AuditLogger,
) {
  const origExecute = toolDef.execute;
  toolDef.execute = async (id: string, params: Record<string, unknown>) => {
    const start = Date.now();
    try {
      const result = await origExecute(id, params);
      const durationMs = Date.now() - start;
      let resultSummary = "";
      try {
        const parsed = JSON.parse(result.content[0]?.text ?? "{}");
        if (parsed.ok === false) {
          resultSummary = `error: ${parsed.error ?? "unknown"}`;
        } else if (Array.isArray(parsed.data)) {
          resultSummary = `${parsed.data.length} items`;
        } else {
          resultSummary = "ok";
        }
      } catch {
        resultSummary = "ok";
      }
      logger({
        ts: new Date().toISOString(),
        tool: toolDef.name,
        actor: "scopelybot",
        params: sanitizeParams(params),
        resultSummary,
        durationMs,
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      logger({
        ts: new Date().toISOString(),
        tool: toolDef.name,
        actor: "scopelybot",
        params: sanitizeParams(params),
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      });
      throw err;
    }
  };
  return toolDef;
}

function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" && v.length > 200) {
      clean[k] = v.slice(0, 200) + "...[truncated]";
    } else {
      clean[k] = v;
    }
  }
  return clean;
}
