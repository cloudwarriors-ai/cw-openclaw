export type AuditLogger = (event: string, details?: Record<string, unknown>) => void;

export function createAuditLogger(_workspaceDir: string): AuditLogger {
  return (event, details) => {
    console.log(`[presalespebot] ${event}`, details ? JSON.stringify(details) : "");
  };
}

export function wrapToolWithAudit<
  T extends { name: string; execute: (...args: never[]) => unknown },
>(tool: T, logger: AuditLogger): T {
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(...args: Parameters<T["execute"]>) {
      logger("tool_called", { tool: tool.name });
      try {
        const result = await original(...args);
        logger("tool_succeeded", { tool: tool.name });
        return result;
      } catch (err) {
        logger("tool_failed", {
          tool: tool.name,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}
