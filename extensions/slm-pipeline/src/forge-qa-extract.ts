import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type ForgeQuestionAnswerPair = {
  question: string;
  answer: string;
  messageId: string;
  threadId?: string;
  channelId?: string;
  channelName?: string;
  channelFile: string;
  createdAt: string;
};

export type QaApprovedReviewEvent = {
  event_id: string;
  tenant_id: string;
  trace_id: string;
  event_type: "qa.approved";
  created_at: string;
  input_hash: string;
  output_hash: string;
  ref_id: string;
  actor_id: string;
  actor_name: string;
  source_channel_jid?: string;
  question: string;
  answer: string;
  metadata: Record<string, unknown>;
};

export type ForgeQaExtractionSummary = {
  scanned_files: number;
  scanned_messages: number;
  extracted_pairs: number;
  deduped_pairs: number;
};

export type ForgeQaExtractionResult = ForgeQaExtractionSummary & {
  events: QaApprovedReviewEvent[];
};

type ForgeChannelMessage = {
  message_id?: string;
  thread_id?: string;
  timestamp?: string;
  created_at?: string;
  text?: string;
};

type ForgeChannelPayload = {
  channel_id?: string;
  channel_name?: string;
  messages?: ForgeChannelMessage[];
};

const DEFAULT_MAX_PAIRS = 50;
const DEFAULT_MAX_FILES = 1200;
const QUESTION_REGEX = /\bQuestion\s*:/gi;
const ANSWER_REGEX = /\bAnswer\s*:/gi;

export function extractQuestionAnswerPairsFromText(text: string): Array<{
  question: string;
  answer: string;
}> {
  const normalized = normalizeSourceText(text);
  if (!normalized) {
    return [];
  }

  const out: Array<{ question: string; answer: string }> = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const questionMatch = findLabel(QUESTION_REGEX, normalized, cursor);
    if (!questionMatch) {
      break;
    }
    const answerMatch = findLabel(ANSWER_REGEX, normalized, questionMatch.end);
    if (!answerMatch) {
      break;
    }
    const nextQuestion = findLabel(QUESTION_REGEX, normalized, answerMatch.end);
    const question = normalizeQaText(normalized.slice(questionMatch.end, answerMatch.start));
    const answer = normalizeQaText(
      normalized.slice(answerMatch.end, nextQuestion?.start ?? normalized.length),
    );

    if (question.length >= 3 && answer.length >= 3) {
      out.push({ question, answer });
    }

    cursor = nextQuestion?.start ?? normalized.length;
  }

  return out;
}

export async function extractApprovedReviewEventsFromForge(params: {
  forgeDir: string;
  tenantId: string;
  maxPairs?: number;
  maxFiles?: number;
  actorId?: string;
  actorName?: string;
  channelNamePattern?: string;
  now?: () => Date;
}): Promise<ForgeQaExtractionResult> {
  const maxPairs = clampPositiveInteger(params.maxPairs, DEFAULT_MAX_PAIRS);
  const maxFiles = clampPositiveInteger(params.maxFiles, DEFAULT_MAX_FILES);
  const actorId = (params.actorId ?? "forge-seed").trim() || "forge-seed";
  const actorName = (params.actorName ?? "forge-seed").trim() || "forge-seed";
  const channelPattern = buildChannelPattern(params.channelNamePattern);
  const channelsDir = path.join(params.forgeDir, "outputs", "zoom_channels");
  const fallbackNow = params.now ?? (() => new Date());

  const files = await listChannelFiles(channelsDir, maxFiles);
  const seenQuestionKeys = new Set<string>();
  const events: QaApprovedReviewEvent[] = [];
  let scannedFiles = 0;
  let scannedMessages = 0;
  let extractedPairs = 0;

  for (const file of files) {
    if (events.length >= maxPairs) {
      break;
    }

    const payload = await readChannelPayload(file.fullPath);
    if (!payload) {
      continue;
    }
    if (channelPattern && payload.channel_name && !channelPattern.test(payload.channel_name)) {
      continue;
    }

    scannedFiles += 1;
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    for (const message of messages) {
      if (events.length >= maxPairs) {
        break;
      }
      scannedMessages += 1;
      const text = typeof message.text === "string" ? message.text : "";
      if (!text.trim()) {
        continue;
      }
      const pairs = extractQuestionAnswerPairsFromText(text);
      if (pairs.length === 0) {
        continue;
      }
      extractedPairs += pairs.length;
      const createdAt = normalizeTimestamp(
        message.timestamp,
        normalizeTimestamp(message.created_at, file.lastModifiedIso),
      );

      for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
        if (events.length >= maxPairs) {
          break;
        }
        const pair = pairs[pairIndex];
        if (!pair) {
          continue;
        }
        const questionKey = normalizeQuestionKey(pair.question);
        if (!questionKey || seenQuestionKeys.has(questionKey)) {
          continue;
        }
        seenQuestionKeys.add(questionKey);

        const messageId = normalizeMessageId(message.message_id, file.name, pairIndex);
        const threadId = normalizeOptionalString(message.thread_id);
        const qaPair: ForgeQuestionAnswerPair = {
          question: pair.question,
          answer: pair.answer,
          messageId,
          threadId,
          channelId: normalizeOptionalString(payload.channel_id),
          channelName: normalizeOptionalString(payload.channel_name),
          channelFile: file.name,
          createdAt: createdAt ?? fallbackNow().toISOString(),
        };
        events.push(
          toApprovedEvent({
            pair: qaPair,
            tenantId: params.tenantId,
            actorId,
            actorName,
            pairIndex,
          }),
        );
      }
    }
  }

  return {
    events,
    scanned_files: scannedFiles,
    scanned_messages: scannedMessages,
    extracted_pairs: extractedPairs,
    deduped_pairs: events.length,
  };
}

type LabeledMatch = {
  start: number;
  end: number;
};

function findLabel(regexTemplate: RegExp, source: string, from: number): LabeledMatch | null {
  const regex = new RegExp(regexTemplate.source, regexTemplate.flags);
  regex.lastIndex = from;
  const match = regex.exec(source);
  if (!match) {
    return null;
  }
  return {
    start: match.index,
    end: regex.lastIndex,
  };
}

function normalizeSourceText(text: string): string {
  return text.replaceAll("\u00a0", " ").replaceAll("\r\n", "\n");
}

function normalizeQaText(text: string): string {
  return text
    .replaceAll("\u00a0", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeMessageId(raw: string | undefined, fallbackSeed: string, pairIndex: number): string {
  const trimmed = normalizeOptionalString(raw);
  if (trimmed) {
    return trimmed;
  }
  const hash = createHash("sha256")
    .update(`${fallbackSeed}:${pairIndex}`)
    .digest("hex")
    .slice(0, 16);
  return `forge-${hash}`;
}

function normalizeTimestamp(primary: string | undefined, fallback?: string): string | undefined {
  const value = normalizeOptionalString(primary) ?? normalizeOptionalString(fallback);
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  return new Date(timestamp).toISOString();
}

function normalizeQuestionKey(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}

function toApprovedEvent(params: {
  pair: ForgeQuestionAnswerPair;
  tenantId: string;
  actorId: string;
  actorName: string;
  pairIndex: number;
}): QaApprovedReviewEvent {
  const stableSeed = [
    params.tenantId,
    params.pair.channelFile,
    params.pair.messageId,
    params.pairIndex,
    params.pair.question,
  ].join("\u0000");
  const eventId = hashToUuid(stableSeed, "event");
  const traceId = hashToUuid(stableSeed, "trace");
  return {
    event_id: eventId,
    tenant_id: params.tenantId,
    trace_id: traceId,
    event_type: "qa.approved",
    created_at: params.pair.createdAt,
    input_hash: hashPayload({
      question: params.pair.question,
      source: params.pair.channelFile,
      thread_id: params.pair.threadId ?? null,
    }),
    output_hash: hashPayload({
      answer: params.pair.answer,
    }),
    ref_id: params.pair.messageId,
    actor_id: params.actorId,
    actor_name: params.actorName,
    source_channel_jid: params.pair.channelId,
    question: params.pair.question,
    answer: params.pair.answer,
    metadata: {
      source: "forge.zoom_channels",
      channel_file: params.pair.channelFile,
      channel_name: params.pair.channelName ?? null,
      thread_id: params.pair.threadId ?? null,
      source_message_id: params.pair.messageId,
    },
  };
}

async function listChannelFiles(
  channelsDir: string,
  maxFiles: number,
): Promise<Array<{ name: string; fullPath: string; lastModifiedIso: string }>> {
  const dirEntries = await fs.readdir(channelsDir, { withFileTypes: true });
  const files = dirEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
  const withStat = await Promise.all(
    files.map(async (name) => {
      const fullPath = path.join(channelsDir, name);
      const stat = await fs.stat(fullPath);
      return {
        name,
        fullPath,
        mtimeMs: stat.mtimeMs,
        lastModifiedIso: stat.mtime.toISOString(),
      };
    }),
  );
  withStat.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStat.slice(0, maxFiles).map((entry) => ({
    name: entry.name,
    fullPath: entry.fullPath,
    lastModifiedIso: entry.lastModifiedIso,
  }));
}

async function readChannelPayload(filePath: string): Promise<ForgeChannelPayload | null> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as ForgeChannelPayload;
  } catch {
    return null;
  }
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function hashToUuid(seed: string, namespace: string): string {
  const hex = createHash("sha256")
    .update(`${namespace}\u0000${seed}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

function buildChannelPattern(raw: string | undefined): RegExp | undefined {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }
  try {
    return new RegExp(value, "i");
  } catch {
    return undefined;
  }
}
