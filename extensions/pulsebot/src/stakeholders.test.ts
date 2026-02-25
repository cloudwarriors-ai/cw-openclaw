import { describe, expect, it } from "vitest";

import {
  buildStakeholderWorkPrefix,
  extractStakeholdersFromIssue,
  parseIssueNumberFromUrl,
  resolveStakeholderDmTarget,
  upsertStakeholderBlock,
} from "./stakeholders.js";

describe("stakeholder helpers", () => {
  it("upserts and then extracts reporter/stakeholders", () => {
    const body = "Issue details";
    const next = upsertStakeholderBlock(body, {
      reporter: "Doug.Ruby@cloudwarriors.ai",
      stakeholders: ["@voipin", "trent.mitchell@cloudwarriors.ai"],
    });
    const parsed = extractStakeholdersFromIssue({ body: next });
    expect(parsed.reporter).toBe("doug.ruby@cloudwarriors.ai");
    expect(parsed.stakeholders).toContain("doug.ruby@cloudwarriors.ai");
    expect(parsed.stakeholders).toContain("@voipin");
    expect(parsed.stakeholders).toContain("trent.mitchell@cloudwarriors.ai");
  });

  it("builds a comment prefix with stakeholder mentions", () => {
    const prefix = buildStakeholderWorkPrefix([
      "@voipin",
      "doug.ruby@cloudwarriors.ai",
      "@trent",
    ]);
    expect(prefix).toContain("/cc @voipin @trent");
    expect(prefix).toContain("Stakeholders:");
  });

  it("resolves dm targets using mapping and default domain", () => {
    const mapped = resolveStakeholderDmTarget("@voipin", {
      mapEnv: "voipin=doug.ruby@cloudwarriors.ai",
      defaultDomain: "cloudwarriors.ai",
    });
    expect(mapped).toBe("doug.ruby@cloudwarriors.ai");

    const fallback = resolveStakeholderDmTarget("@trent", {
      defaultDomain: "cloudwarriors.ai",
    });
    expect(fallback).toBe("trent@cloudwarriors.ai");
  });

  it("parses issue numbers from github urls", () => {
    expect(parseIssueNumberFromUrl("https://github.com/cloudwarriors-ai/cw-openclaw/issues/123"))
      .toBe(123);
    expect(parseIssueNumberFromUrl("not-an-issue-url")).toBeNull();
  });
});

