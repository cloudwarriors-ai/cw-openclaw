import os from "node:os";
import path from "node:path";

/**
 * Keep Zoom uploads under OpenClaw state media root so media tools can read them.
 * This path is included in default local media roots.
 */
export function resolveZoomUploadDir(): string {
  return path.resolve(os.homedir(), ".openclaw", "media", "zoom-uploads");
}

// Uploads are transient hand-off artifacts (the durable copy goes to the customer
// dir). After this window they are no longer served and get pruned on the next
// upload. Bounds both disk growth and how long a leaked download URL stays live.
export const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * True only when filePath resolves to a location strictly inside the uploads dir.
 * Canonical resolve + relative check — a plain startsWith prefix test would accept
 * sibling dirs like "zoom-uploads-evil" and traversal via "..".
 */
export function isWithinUploadDir(filePath: string): boolean {
  const uploadDir = resolveZoomUploadDir();
  const rel = path.relative(uploadDir, path.resolve(filePath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
