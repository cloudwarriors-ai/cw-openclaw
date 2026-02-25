import { describe, expect, it } from "vitest";
import { isLikelyClarifyingQuestion, selectTrainedAnswerCandidate } from "./trained-answer.js";

describe("selectTrainedAnswerCandidate", () => {
  it("selects a high-confidence trained Q/A match", () => {
    const query = "Can I get an engineer to jump on a call and discuss a project?";
    const candidate = selectTrainedAnswerCandidate({
      query,
      results: [
        {
          path: "memory/customers/test-customer/channel.md",
          score: 0.71,
          snippet: [
            "**Q:** Can I get an engineer to jump on a call and discuss a project?",
            "",
            "**A:** Yes — if CloudWarriors is the partner on this, we can provide engineering support. Is CloudWarriors registered on the deal?",
            "",
            "**Insight:** Customer interested in: number porting",
          ].join("\n"),
        },
      ],
    });

    expect(candidate?.answer).toContain("CloudWarriors is the partner");
    expect(candidate?.score).toBe(0.71);
  });

  it("selects a trained answer for close paraphrases with moderate vector score", () => {
    const candidate = selectTrainedAnswerCandidate({
      query: "can we get an engineer to join the channel",
      results: [
        {
          path: "memory/customers/test-customer/channel.md",
          score: 0.27,
          snippet: [
            "**Q:** Can I get an engineer to jump on a call and discuss a project?",
            "",
            "**A:** Yes — if CloudWarriors is the partner on this, we can provide engineering support. Is CloudWarriors registered on the deal?",
            "",
            "**Insight:** Customer interested in: number porting",
          ].join("\n"),
        },
      ],
    });

    expect(candidate?.answer).toContain("CloudWarriors is the partner");
    expect(candidate?.score).toBe(0.27);
  });

  it("returns undefined when match is low confidence", () => {
    const candidate = selectTrainedAnswerCandidate({
      query: "How do I reset my password?",
      results: [
        {
          path: "memory/customers/test-customer/channel.md",
          score: 0.31,
          snippet: [
            "**Q:** Can I get an engineer to jump on a call and discuss a project?",
            "",
            "**A:** Yes — if CloudWarriors is the partner on this, we can provide engineering support. Is CloudWarriors registered on the deal?",
            "",
            "**Insight:** Customer interested in: number porting",
          ].join("\n"),
        },
      ],
    });

    expect(candidate).toBeUndefined();
  });
});

describe("isLikelyClarifyingQuestion", () => {
  it("detects generic clarifying follow-up patterns", () => {
    expect(
      isLikelyClarifyingQuestion(
        "Absolutely! What type of project is this for — a new Zoom Phone deployment, a migration from another platform, or something else?",
      ),
    ).toBe(true);
  });

  it("does not flag concrete trained answers", () => {
    expect(
      isLikelyClarifyingQuestion(
        "Yes — if CloudWarriors is the partner on this, we can provide engineering support. Is CloudWarriors registered on the deal?",
      ),
    ).toBe(false);
  });
});
