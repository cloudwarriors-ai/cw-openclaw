// Formats ScopelyBot's model-authored replies for Zoom's plain-text card body.

export type ScopelyZoomMessageContext = {
  channelId: string;
  sessionKey?: string;
};

const SCOPELYBOT_SESSION_PREFIX = "agent:scopelybot:";

/** Restricts readable-output rewriting to ScopelyBot's own Zoom session. */
export function isScopelyBotZoomMessage(ctx: ScopelyZoomMessageContext): boolean {
  return ctx.channelId === "zoom" && ctx.sessionKey?.startsWith(SCOPELYBOT_SESSION_PREFIX) === true;
}

/** Removes unsupported Markdown presentation while preserving the reply's useful text. */
export function formatScopelyZoomText(content: string): string {
  return content
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]*```[^\n]*$/gm, "")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^\s*\n](?:[^*\n]*?[^\s*\n])?)\*(?=$|[\s).,!?;:])/g, "$1$2")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Returns a hook rewrite only when a ScopelyBot Zoom reply actually changes. */
export function rewriteScopelyBotZoomMessage(
  content: string,
  ctx: ScopelyZoomMessageContext,
): { content: string } | undefined {
  if (!isScopelyBotZoomMessage(ctx)) return undefined;
  const formatted = formatScopelyZoomText(content);
  return formatted === content ? undefined : { content: formatted };
}
