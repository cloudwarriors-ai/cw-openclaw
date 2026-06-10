import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import {
  copyDocToCustomer,
  ensureCustomerDir,
  resolveWorkspaceDirForAgent,
} from "./channel-memory.js";
import type { ZoomMessageHandlerDeps } from "./monitor-handler.js";
import { routeMessageToAgent } from "./monitor-handler.js";
import { getUploadErrorHtml, getUploadPageHtml } from "./upload-page.js";
import { resolveZoomUploadDir, UPLOAD_TTL_MS } from "./upload-path.js";
import { consumeUploadToken, peekUploadToken } from "./upload-tokens.js";

const UPLOAD_DIR = resolveZoomUploadDir();
// Server-side cap matching the advertised limit. The express body limit (15mb)
// is NOT the enforcement point — base64 overhead would let ~11MB files through,
// and client-side JS checks are trivially bypassed by POSTing JSON directly.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 2000;
const MAX_PDF_PREVIEW_CHARS = 3000;
const MAX_PDF_PREVIEW_LINES = 40;
const DEFAULT_EXEC_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const PDFTOTEXT_CANDIDATES = Array.from(
  new Set(
    [
      process.env.PDFTOTEXT_BIN,
      "/usr/bin/pdftotext",
      "/usr/local/bin/pdftotext",
      "pdftotext",
    ].filter((entry): entry is string => Boolean(entry)),
  ),
);

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Uploads are transient (the durable copy lives in the customer dir). Prune
// token-dirs older than the TTL on each authorized upload — bounded cost (one
// readdir per upload), no timer lifecycle to manage, and keeps the serve-side
// TTL gate (monitor.ts) and on-disk state in agreement.
function pruneExpiredUploads(): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });
  } catch {
    return; // uploads dir may not exist yet
  }
  const cutoff = Date.now() - UPLOAD_TTL_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(UPLOAD_DIR, entry.name);
    try {
      if (fs.statSync(dirPath).mtimeMs < cutoff) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } catch {
      // best-effort cleanup; never fail an upload over it
    }
  }
}

export function createUploadRoutes(deps: ZoomMessageHandlerDeps) {
  const { cfg, log } = deps;

  function handleGet(req: Request, res: Response): void {
    const token = req.query.token as string | undefined;
    if (!token || !peekUploadToken(token)) {
      res
        .status(400)
        .type("html")
        .send(getUploadErrorHtml("This upload link is invalid or has expired."));
      return;
    }
    res.type("html").send(getUploadPageHtml(token));
  }

  async function handlePost(req: Request, res: Response): Promise<void> {
    try {
      const { token, filename, mimeType, size, data } = req.body ?? {};

      if (!token || !filename || !data) {
        res.status(400).json({ ok: false, error: "Missing required fields." });
        return;
      }

      // Decode and enforce the size cap BEFORE consuming the single-use token,
      // so an oversize attempt doesn't burn the user's upload link.
      const base64Match = String(data).match(/^data:[^;]*;base64,(.*)$/);
      const fileBuffer = base64Match
        ? Buffer.from(base64Match[1], "base64")
        : Buffer.from(String(data), "base64");
      if (fileBuffer.length > MAX_UPLOAD_BYTES) {
        res.status(413).json({
          ok: false,
          error: `File exceeds the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit.`,
        });
        return;
      }

      const ctx = consumeUploadToken(token as string);
      if (!ctx) {
        res.status(401).json({ ok: false, error: "Invalid or expired upload token." });
        return;
      }

      pruneExpiredUploads();

      const tokenDir = path.join(UPLOAD_DIR, token as string);
      ensureDir(tokenDir);

      // Build descriptive filename: {label}_{date}_{original} or {date}_{original}
      const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const origName = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
      const ext = path.extname(origName);
      const base = path.basename(origName, ext);
      const labelSlug = ctx.label ? ctx.label.replace(/[^a-zA-Z0-9_-]/g, "_") : "";
      const safeName = labelSlug ? `${labelSlug}_${date}_${base}${ext}` : `${date}_${base}${ext}`;
      const filePath = path.join(tokenDir, safeName);

      fs.writeFileSync(filePath, fileBuffer);

      const sizeKB = Math.round((size as number) / 1024);
      const mime = String(mimeType || "application/octet-stream");

      // Never inline full file content — large files kill the LLM context.
      // Save the file, tell the agent where it is with a short preview.
      let agentText: string;
      if (mime.startsWith("image/")) {
        agentText = `[FILE_UPLOAD image] ${safeName} (${mime}, ${sizeKB}KB) saved to ${filePath}`;
      } else if (mime === "application/pdf" || /\.pdf$/i.test(safeName)) {
        // Prefer extracting a compact PDF preview at upload time so the model
        // can proceed without needing privileged exec tools in-chat.
        let pdfText = "";
        let extractionDetails = "";
        for (const bin of PDFTOTEXT_CANDIDATES) {
          try {
            const result = spawnSync(bin, [filePath, "-"], {
              encoding: "utf-8",
              timeout: 8000,
              maxBuffer: 2 * 1024 * 1024,
              env: {
                ...process.env,
                PATH: [process.env.PATH, DEFAULT_EXEC_PATH].filter(Boolean).join(":"),
              },
            });
            if (result.status === 0 && result.stdout) {
              pdfText = String(result.stdout);
              extractionDetails = `ok bin=${bin} chars=${pdfText.length}`;
              break;
            }
            const stderr = result.stderr ? String(result.stderr).trim().slice(0, 220) : "";
            const err = result.error ? String(result.error) : "";
            extractionDetails = [
              `bin=${bin}`,
              `status=${result.status ?? "null"}`,
              `signal=${result.signal ?? "none"}`,
              err ? `error=${err}` : "",
              stderr ? `stderr=${stderr}` : "",
            ]
              .filter(Boolean)
              .join(" ");
          } catch (err) {
            extractionDetails = `bin=${bin} threw=${String(err)}`;
          }
        }

        if (pdfText.trim().length > 0) {
          const normalized = pdfText.replace(/\r\n/g, "\n").trim();
          const sliced = normalized.slice(0, MAX_PDF_PREVIEW_CHARS);
          const lines = sliced.split("\n").slice(0, MAX_PDF_PREVIEW_LINES);
          const preview = lines.join("\n");
          const truncatedByChars = normalized.length > sliced.length;
          const truncatedByLines = sliced.split("\n").length > lines.length;
          const truncated =
            truncatedByChars || truncatedByLines
              ? `\n\n_(truncated — full PDF is ${sizeKB}KB, use \`exec pdftotext \"${filePath}\" -\` for full text)_`
              : "";
          const totalLines = normalized.split("\n").length;
          agentText = `[FILE_UPLOAD pdf] ${safeName} (${sizeKB}KB, ${totalLines} text lines) saved to ${filePath}\n\nPreview (first ${lines.length} lines):\n${preview}${truncated}`;
        } else {
          log.warn("pdf text extraction unavailable", {
            filePath,
            mime,
            path: process.env.PATH,
            details: extractionDetails || "all candidates failed",
          });
          agentText = `[FILE_UPLOAD pdf] ${safeName} (${sizeKB}KB) saved to ${filePath}\n\nText extraction unavailable.`;
        }
      } else if (
        mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        /\.docx$/i.test(safeName)
      ) {
        const { readDocxParagraphs } = await import("./docx-tools.js");
        const paragraphs = await readDocxParagraphs(filePath);
        const preview = paragraphs
          .slice(0, 10)
          .map((p) => `[${p.index}${p.style ? ` ${p.style}` : ""}] ${p.text}`)
          .join("\n");
        agentText = `[FILE_UPLOAD docx] ${safeName} (${sizeKB}KB, ${paragraphs.length} paragraphs) saved to ${filePath}\n\nPreview (first 10 paragraphs):\n${preview}`;
      } else if (
        mime.startsWith("text/") ||
        mime === "application/json" ||
        mime === "application/xml" ||
        /\.(txt|csv|json|xml|html|md|log|yaml|yml|toml)$/i.test(safeName)
      ) {
        const preview = fileBuffer.subarray(0, MAX_PREVIEW_BYTES).toString("utf-8");
        const lines = preview.split("\n");
        const truncated =
          fileBuffer.length > MAX_PREVIEW_BYTES
            ? `\n\n_(truncated — full file is ${sizeKB}KB, use \`exec cat ${filePath}\` to read more)_`
            : "";
        agentText = `[FILE_UPLOAD document] ${safeName} (${mime}, ${sizeKB}KB, ${fileBuffer.toString("utf-8").split("\n").length} lines) saved to ${filePath}\n\nPreview (first ${lines.length} lines):\n${preview}${truncated}`;
      } else {
        agentText = `[FILE_UPLOAD] ${safeName} (${mime}, ${sizeKB}KB) saved to ${filePath}`;
      }

      // Copy uploaded file to the customer directory if we have a channel context
      if (ctx.channelName) {
        const slug =
          ctx.channelName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "unknown";
        try {
          const workspaceDir = resolveWorkspaceDirForAgent(cfg, ctx.agentId);
          await ensureCustomerDir(slug, ctx.channelName, ctx.channelJid, workspaceDir);
          await copyDocToCustomer(slug, filePath, safeName, workspaceDir);
        } catch (copyErr) {
          log.error("failed to copy upload to customer dir", { error: String(copyErr) });
        }
      }

      // For DMs, reply to userJid (the actual Zoom JID).
      // ctx.conversationId may be an internal session ID the LLM passed, not a JID.
      const replyTo = ctx.isDirect ? ctx.userJid : (ctx.channelJid ?? ctx.userJid);

      await routeMessageToAgent({
        deps,
        conversationId: replyTo,
        senderId: ctx.userJid,
        senderName: ctx.userName,
        senderEmail: ctx.userEmail,
        text: agentText,
        isDirect: ctx.isDirect,
        channelJid: ctx.channelJid,
        channelName: ctx.channelName,
        sessionKeyOverride: ctx.sessionKey,
        agentIdOverride: ctx.agentId,
        accountIdOverride: ctx.accountId,
        replyToMessageId: ctx.replyMainMessageId,
      });

      res.json({ ok: true });
    } catch (err) {
      log.error("upload handler error", { error: String(err) });
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "Internal server error." });
      }
    }
  }

  return { handleGet, handlePost };
}
