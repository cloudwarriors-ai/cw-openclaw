import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { createSlmDashboardApp } from "../../apps/slm-dashboard/src/server/app.js";
import { createPasswordHash } from "../../apps/slm-dashboard/src/server/password.js";
import type { DashboardConfig, GatewayMethodClient } from "../../apps/slm-dashboard/src/server/types.js";

type QaProjection = {
  projection_id: string;
  question: string;
  answer: string;
  source_channel: string;
  source_ref: string;
  updated_at: string;
};

type Harness = {
  baseUrl: string;
  qaRecords: QaProjection[];
  close: () => Promise<void>;
};

describe("slm dashboard playwright e2e", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup.pop()?.();
    }
  });

  it("authenticates and runs qa/training flows through the dashboard UI", async () => {
    const harness = await createHarness();
    cleanup.push(harness.close);

    const browser = await chromium.launch({
      headless: true,
    });
    cleanup.push(async () => {
      await browser.close();
    });

    const page = await browser.newPage();
    await page.goto(harness.baseUrl, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForSelector("#login-panel");
    await page.fill("#login-username", "operator");
    await page.fill("#login-password", "pass123");
    await page.click("#login-form button[type=submit]");
    await page.waitForFunction(
      () => !document.querySelector("#dashboard-panel")?.classList.contains("hidden"),
    );

    const meLine = (await page.textContent("#me-line")) ?? "";
    expect(meLine).toContain("tenant tenant-a");

    await page.waitForSelector("#qa-table-body tr");
    const rowCount = await page.locator("#qa-table-body tr").count();
    expect(rowCount).toBeGreaterThan(0);

    await page.locator("#qa-table-body tr").first().click();
    await page.fill("#qa-answer", "Updated answer from Playwright gate.");
    await page.click("#qa-update-form button[type=submit]");
    await page.waitForFunction(
      () =>
        (document.querySelector("#qa-update-status")?.textContent ?? "").includes("Answer updated."),
    );

    expect(harness.qaRecords[0]?.answer).toBe("Updated answer from Playwright gate.");

    await page.fill("#session-question", "How should we respond to incidents?");
    await page.click("#session-start-form button[type=submit]");
    await page.waitForFunction(
      () => (document.querySelector("#session-id")?.textContent ?? "").includes("Active session:"),
    );

    await page.fill("#session-prompt", "Give me a customer-facing update.");
    await page.fill("#session-edited-answer", "Acknowledge impact, mitigation, and next ETA.");
    await page.click("#session-turn-form button[type=submit]");
    await page.waitForFunction(
      () => (document.querySelector("#session-output")?.textContent ?? "").includes("turn_id"),
    );

    await page.click("#session-finish");
    await page.waitForFunction(
      () => (document.querySelector("#session-id")?.textContent ?? "").includes("No active session"),
    );

    await page.fill("#training-base-model", "forge/slm-base");
    await page.fill("#training-split-seed", "7");
    await page.click("#training-form button[type=submit]");
    await page.waitForFunction(
      () => (document.querySelector("#training-output")?.textContent ?? "").includes("dataset_id"),
    );

    const traceCount = await page.locator("#trace-list .trace-item").count();
    expect(traceCount).toBeGreaterThan(0);
  });
});

async function createHarness(): Promise<Harness> {
  const qaRecords: QaProjection[] = [
    {
      projection_id: "6ab2df52-c6f6-42fc-84d1-a38e29659f03",
      question: "How do we run safe deploys?",
      answer: "Use canary rollout, observe metrics, and keep rollback checkpoints.",
      source_channel: "zoom",
      source_ref: "zoom-msg-1",
      updated_at: "2026-02-24T00:00:00.000Z",
    },
  ];
  const sessionId = "7f5788a3-4f09-4f03-9236-ad8ea0953697";

  const gatewayClient: GatewayMethodClient = {
    request: async (method, params) => {
      switch (method) {
        case "slm.control.qa.list":
          return {
            records: qaRecords,
            next_cursor: null,
          };
        case "slm.control.qa.get": {
          const projectionId = asString(params.projection_id);
          return {
            record: qaRecords.find((entry) => entry.projection_id === projectionId),
          };
        }
        case "slm.control.qa.update": {
          const projection = qaRecords[0];
          if (!projection) {
            throw new Error("qa projection not found");
          }
          projection.question = asString(params.question) ?? projection.question;
          projection.answer = asString(params.answer) ?? projection.answer;
          projection.source_channel = asString(params.source_channel) ?? projection.source_channel;
          projection.source_ref = asString(params.source_ref) ?? projection.source_ref;
          projection.updated_at = new Date().toISOString();
          return { record: projection };
        }
        case "slm.control.session.start":
          return {
            session: {
              session_id: sessionId,
            },
          };
        case "slm.control.session.turn":
          return {
            session: {
              session_id: sessionId,
            },
            turn: {
              turn_id: "2ad03256-2e13-4f48-b554-a57bcbf70b12",
            },
            supervisor: {
              trace_id: "4c78d1fd-8f67-4efa-8d1f-c68934f2ecdb",
              final_answer: "SLM answer",
            },
          };
        case "slm.control.session.finish":
          return {
            session: {
              session_id: sessionId,
              status: "finished",
            },
          };
        case "slm.control.training.enqueue":
          return {
            dataset_id: "2f54e7f1-70b5-4fe4-b217-a3eaf8dba4f9",
            run_id: "af0191ab-c6d8-412b-be4b-8f9ceef25a45",
            status: "queued",
            attempts: 1,
          };
        default:
          throw new Error(`unknown method ${method}`);
      }
    },
  };

  const config: DashboardConfig = {
    port: 0,
    cookieName: "slm_dashboard_session",
    cookieSecure: false,
    sessionTtlMs: 30 * 60 * 1000,
    gatewayUrl: "ws://127.0.0.1:18789",
    gatewayToken: "token",
    gatewayPassword: undefined,
    gatewayTimeoutMs: 15_000,
    users: [
      {
        username: "operator",
        passwordHash: createPasswordHash("pass123"),
        tenantId: "tenant-a",
        displayName: "Operator",
      },
    ],
  };

  const clientDir = fileURLToPath(new URL("../../apps/slm-dashboard/src/client", import.meta.url));
  const { app } = createSlmDashboardApp({
    config,
    gatewayClient,
    clientDir,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    qaRecords,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
