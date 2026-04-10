export function jsonResult(data: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function errorResult(err: unknown): { content: { type: "text"; text: string }[] } {
  const message = err instanceof Error ? err.message : String(err);
  return jsonResult({ ok: false, error: message });
}
