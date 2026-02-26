import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractApprovedReviewEventsFromForge,
  extractQuestionAnswerPairsFromText,
} from "./forge-qa-extract.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("extractQuestionAnswerPairsFromText", () => {
  it("extracts normalized question and answer pairs", () => {
    const pairs = extractQuestionAnswerPairsFromText(`
Question:   How do I create API routes?

Answer: Use Next.js route handlers in src/app/api.

Question: Can I centralize styles?
Answer: Yes. Move theme variables into globals.css.
`);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({
      question: "How do I create API routes?",
      answer: "Use Next.js route handlers in src/app/api.",
    });
    expect(pairs[1]).toEqual({
      question: "Can I centralize styles?",
      answer: "Yes. Move theme variables into globals.css.",
    });
  });

  it("returns empty when no complete pair exists", () => {
    const pairs = extractQuestionAnswerPairsFromText("Question: where is the bug?");
    expect(pairs).toEqual([]);
  });
});

describe("extractApprovedReviewEventsFromForge", () => {
  it("builds qa.approved events with dedupe and deterministic ids", async () => {
    const forgeDir = await makeForgeDir([
      {
        file: "channel-a.json",
        channel_id: "chan-a",
        channel_name: "Channel A",
        messages: [
          {
            message_id: "msg-1",
            thread_id: "thread-1",
            timestamp: "2025-10-23T15:03:12.924000+00:00",
            text: "Question: How do I set up Swagger docs?\n\nAnswer: Add swagger-ui-react and a docs route.",
          },
          {
            message_id: "msg-2",
            thread_id: "thread-2",
            timestamp: "2025-10-23T15:04:12.924000+00:00",
            text: "Question: How do I set up Swagger docs?\n\nAnswer: Duplicate answer should dedupe by question.",
          },
        ],
      },
      {
        file: "channel-b.json",
        channel_id: "chan-b",
        channel_name: "Channel B",
        messages: [
          {
            message_id: "msg-3",
            thread_id: "thread-3",
            timestamp: "2025-10-23T16:03:12.924000+00:00",
            text: "Question: Should I use a global styles file?\n\nAnswer: Yes, keep app theme variables centralized.",
          },
        ],
      },
    ]);

    const first = await extractApprovedReviewEventsFromForge({
      forgeDir,
      tenantId: "tenant-local",
      maxPairs: 10,
      maxFiles: 10,
    });
    const second = await extractApprovedReviewEventsFromForge({
      forgeDir,
      tenantId: "tenant-local",
      maxPairs: 10,
      maxFiles: 10,
    });

    expect(first.scanned_files).toBe(2);
    expect(first.extracted_pairs).toBe(3);
    expect(first.deduped_pairs).toBe(2);
    expect(first.events).toHaveLength(2);
    const byQuestion = new Map(first.events.map((event) => [event.question, event]));
    const secondByQuestion = new Map(second.events.map((event) => [event.question, event]));
    expect(byQuestion.size).toBe(2);

    for (const [question, event] of byQuestion) {
      expect(event.event_type).toBe("qa.approved");
      expect(event.tenant_id).toBe("tenant-local");
      expect(event.actor_id).toBe("forge-seed");
      expect(event.metadata.source).toBe("forge.zoom_channels");
      expect(typeof event.input_hash).toBe("string");
      expect(event.input_hash).toHaveLength(64);
      expect(secondByQuestion.get(question)?.event_id).toBe(event.event_id);
      expect(secondByQuestion.get(question)?.trace_id).toBe(event.trace_id);
    }
  });

  it("respects maxPairs and channel_name pattern", async () => {
    const forgeDir = await makeForgeDir([
      {
        file: "channel-a.json",
        channel_id: "chan-a",
        channel_name: "DevOps",
        messages: [
          {
            message_id: "msg-1",
            timestamp: "2025-10-23T15:03:12.924000+00:00",
            text: "Question: Q1?\n\nAnswer: A1.",
          },
          {
            message_id: "msg-2",
            timestamp: "2025-10-23T15:05:12.924000+00:00",
            text: "Question: Q2?\n\nAnswer: A2.",
          },
        ],
      },
      {
        file: "channel-b.json",
        channel_id: "chan-b",
        channel_name: "Sales",
        messages: [
          {
            message_id: "msg-3",
            timestamp: "2025-10-23T16:03:12.924000+00:00",
            text: "Question: Q3?\n\nAnswer: A3.",
          },
        ],
      },
    ]);

    const result = await extractApprovedReviewEventsFromForge({
      forgeDir,
      tenantId: "tenant-local",
      maxPairs: 1,
      channelNamePattern: "devops",
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.metadata.channel_name).toBe("DevOps");
  });
});

async function makeForgeDir(
  channels: Array<{
    file: string;
    channel_id: string;
    channel_name: string;
    messages: Array<Record<string, unknown>>;
  }>,
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-qa-extract-"));
  tempDirs.push(root);
  const channelsDir = path.join(root, "outputs", "zoom_channels");
  await fs.mkdir(channelsDir, { recursive: true });
  for (const channel of channels) {
    const payload = {
      channel_id: channel.channel_id,
      channel_name: channel.channel_name,
      source: "test",
      messages: channel.messages,
    };
    const filePath = path.join(channelsDir, channel.file);
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  return root;
}
