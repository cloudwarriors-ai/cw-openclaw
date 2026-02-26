import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { createSlmDashboardApp } from "../../apps/slm-dashboard/src/server/app.js";
import { createPasswordHash } from "../../apps/slm-dashboard/src/server/password.js";
import type { DashboardConfig, DashboardRole, GatewayMethodClient } from "../../apps/slm-dashboard/src/server/types.js";

type QaProjection = {
  projection_id: string;
  question: string;
  answer: string;
  source_channel?: string;
  source_ref?: string;
  provider_key?: string;
  channel_key?: string;
  category_id?: string;
  category_key?: string;
  status: "draft" | "validated" | "archived";
  origin: "manual" | "studio" | "import";
  updated_at: string;
  approved_at: string;
};

type QaCategory = {
  category_id: string;
  provider_key: string;
  channel_key: string;
  category_key: string;
  display_name: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type Harness = {
  baseUrl: string;
  qaRecords: QaProjection[];
  categories: QaCategory[];
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

  it("trainer role can manage categories/library and run studio/training flows", async () => {
    const harness = await createHarness("trainer");
    cleanup.push(harness.close);

    const browser = await chromium.launch({ headless: true });
    cleanup.push(async () => {
      await browser.close();
    });

    const page = await browser.newPage();
    await page.goto(harness.baseUrl, { waitUntil: "domcontentloaded" });

    await page.fill("#login-username", "operator");
    await page.fill("#login-password", "pass123");
    await page.click("#login-form button[type=submit]");
    await page.waitForFunction(
      () => !document.querySelector("#dashboard-panel")?.classList.contains("hidden"),
    );

    expect(await page.locator("#me-line").textContent()).toContain("role trainer");
    expect(await page.locator("#factory-lane").isVisible()).toBe(true);

    await page.fill("#category-create-provider", "zoom");
    await page.fill("#category-create-channel", "phone");
    await page.fill("#category-create-key", "security");
    await page.fill("#category-create-name", "Security");
    await page.click("#category-create-form button[type=submit]");
    await page.waitForFunction(
      () => (document.querySelector("#category-status")?.textContent ?? "").includes("Category created."),
    );

    await page.fill("#qa-create-provider", "zoom");
    await page.fill("#qa-create-channel", "support");
    await page.selectOption("#qa-create-category", { index: 0 });
    await page.selectOption("#qa-create-status", "draft");
    await page.fill("#qa-create-question", "How do we update phone routing?");
    await page.fill("#qa-create-answer", "Use queue fallback and after-hours rules.");
    await page.click("#qa-create-form button[type=submit]");
    await page.waitForFunction(
      () => (document.querySelector("#qa-update-status")?.textContent ?? "").includes("Q&A created."),
    );

    const rowCount = await page.locator("#qa-table-body tr").count();
    expect(rowCount).toBeGreaterThan(0);

    await page.selectOption("#filter-status", "draft");
    await page.locator("#qa-table-body tr").first().locator(".qa-action-validate").click();
    await page.waitForFunction(
      () => (document.querySelector("#qa-update-status")?.textContent ?? "").includes("Q&A validated."),
    );
    await page.selectOption("#filter-status", "validated");
    expect((await page.locator("#qa-table-body tr").first().locator("td").nth(4).textContent())?.trim()).toBe(
      "validated",
    );

    await page.locator("#qa-table-body tr").first().locator(".qa-action-archive").click();
    await page.waitForFunction(
      () => (document.querySelector("#qa-update-status")?.textContent ?? "").includes("Q&A archived."),
    );
    await page.selectOption("#filter-status", "archived");
    expect((await page.locator("#qa-table-body tr").first().locator("td").nth(4).textContent())?.trim()).toBe(
      "archived",
    );

    await page.locator("#qa-table-body tr").first().locator(".qa-action-edit").click();
    expect(await page.inputValue("#qa-projection-id")).not.toBe("");

    await page.fill("#qa-answer", "Use queue fallback, after-hours routing, and smoke validation.");
    await page.click("#qa-update-form button[type=submit]");
    await page.waitForFunction(
      () => (document.querySelector("#qa-update-status")?.textContent ?? "").includes("Q&A updated."),
    );

    await page.fill("#session-question", "How should we answer outage questions?");
    await page.click("#session-start-form button[type=submit]");
    await page.waitForFunction(
      () => (document.querySelector("#session-id")?.textContent ?? "").includes("Active session:"),
    );

    await page.fill("#session-prompt", "Give a concise customer response.");
    await page.fill("#session-edited-answer", "Acknowledge impact, mitigation, and next ETA.");
    await page.click("#session-turn-form button[type=submit]");
    await page.waitForFunction(
      () => (document.querySelector("#session-output")?.textContent ?? "").includes("turn_id"),
    );

    await page.fill("#session-save-provider", "zoom");
    await page.fill("#session-save-channel", "support");
    await page.selectOption("#session-save-category", { index: 0 });
    await page.click("#session-save-form button[type=submit]");
    await page.waitForFunction(
      () =>
        (document.querySelector("#session-save-result")?.textContent ?? "").includes(
          "Studio correction saved to library.",
        ),
    );

    await page.fill("#training-base-model", "forge/slm-base");
    await page.selectOption("#training-source", "library");
    await page.fill("#training-provider", "zoom");
    await page.fill("#training-channel", "support");
    await page.click("#training-form button[type=submit]");
    await page.waitForFunction(
      () => (document.querySelector("#training-output")?.textContent ?? "").includes("dataset_id"),
    );

    expect(harness.categories.length).toBeGreaterThan(1);
    expect(harness.qaRecords.length).toBeGreaterThan(1);
  });

  it("operator role keeps practice lane and hides factory lane controls", async () => {
    const harness = await createHarness("operator");
    cleanup.push(harness.close);

    const browser = await chromium.launch({ headless: true });
    cleanup.push(async () => {
      await browser.close();
    });

    const page = await browser.newPage();
    await page.goto(harness.baseUrl, { waitUntil: "domcontentloaded" });

    await page.fill("#login-username", "operator");
    await page.fill("#login-password", "pass123");
    await page.click("#login-form button[type=submit]");
    await page.waitForFunction(
      () => !document.querySelector("#dashboard-panel")?.classList.contains("hidden"),
    );

    expect(await page.locator("#me-line").textContent()).toContain("role operator");
    expect(await page.locator("#factory-lane").isVisible()).toBe(false);
    expect(await page.locator(".qa-action").count()).toBe(0);
    expect((await page.locator("#qa-table-body tr").first().locator(".qa-actions-cell").textContent()) ?? "").toContain(
      "Read only",
    );

    await page.fill("#session-question", "How should I reply to tickets?");
    await page.click("#session-start-form button[type=submit]");
    await page.waitForFunction(
      () => (document.querySelector("#session-id")?.textContent ?? "").includes("Active session:"),
    );
  });
});

async function createHarness(role: DashboardRole): Promise<Harness> {
  const categories: QaCategory[] = [
    {
      category_id: "bb1deec3-cfe4-4ea5-b1ce-f7cfd80587ad",
      provider_key: "zoom",
      channel_key: "support",
      category_key: "general",
      display_name: "General",
      is_active: true,
      sort_order: 1,
      created_at: "2026-02-24T00:00:00.000Z",
      updated_at: "2026-02-24T00:00:00.000Z",
    },
  ];
  const qaRecords: QaProjection[] = [
    {
      projection_id: "6ab2df52-c6f6-42fc-84d1-a38e29659f03",
      question: "How do we run safe deploys?",
      answer: "Use canary rollout, observe metrics, and keep rollback checkpoints.",
      source_channel: "zoom:support",
      source_ref: "zoom-msg-1",
      provider_key: "zoom",
      channel_key: "support",
      category_id: categories[0]?.category_id,
      category_key: categories[0]?.category_key,
      status: "validated",
      origin: "manual",
      approved_at: "2026-02-24T00:00:00.000Z",
      updated_at: "2026-02-24T00:00:00.000Z",
    },
  ];
  const sessionId = "7f5788a3-4f09-4f03-9236-ad8ea0953697";

  const request: GatewayMethodClient["request"] = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
      switch (method) {
        case "slm.control.category.list":
          return {
            records: categories,
            next_cursor: null,
          } as T;
        case "slm.control.category.create": {
          const now = new Date().toISOString();
          const record: QaCategory = {
            category_id: randomUUID(),
            provider_key: asString(params.provider_key) || "zoom",
            channel_key: asString(params.channel_key) || "support",
            category_key: asString(params.category_key) || "new",
            display_name: asString(params.display_name) || "New",
            sort_order: asNumber(params.sort_order) ?? 1000,
            is_active: true,
            created_at: now,
            updated_at: now,
          };
          categories.push(record);
          return { record } as T;
        }
        case "slm.control.category.update": {
          const categoryId = asString(params.category_id);
          const record = categories.find((entry) => entry.category_id === categoryId);
          if (!record) {
            throw new Error("category not found");
          }
          const displayName = asString(params.display_name);
          if (displayName) {
            record.display_name = displayName;
          }
          if (typeof params.is_active === "boolean") {
            record.is_active = params.is_active;
          }
          const sortOrder = asNumber(params.sort_order);
          if (sortOrder !== undefined) {
            record.sort_order = sortOrder;
          }
          record.updated_at = new Date().toISOString();
          return { record } as T;
        }
        case "slm.control.qa.list": {
          const query = asString(params.query)?.toLowerCase();
          const provider = asString(params.provider_key);
          const channel = asString(params.channel_key);
          const categoryId = asString(params.category_id);
          const status = asString(params.status);
          const records = qaRecords.filter((entry) => {
            if (provider && entry.provider_key !== provider) {
              return false;
            }
            if (channel && entry.channel_key !== channel) {
              return false;
            }
            if (categoryId && entry.category_id !== categoryId) {
              return false;
            }
            if (status && entry.status !== status) {
              return false;
            }
            if (!query) {
              return true;
            }
            return `${entry.question}\n${entry.answer}`.toLowerCase().includes(query);
          });
          return {
            records,
            next_cursor: null,
          } as T;
        }
        case "slm.control.qa.get": {
          const projectionId = asString(params.projection_id);
          return {
            record: qaRecords.find((entry) => entry.projection_id === projectionId),
          } as T;
        }
        case "slm.control.qa.create": {
          const now = new Date().toISOString();
          const categoryId = asString(params.category_id) || categories[0]?.category_id;
          const category = categories.find((entry) => entry.category_id === categoryId);
          const record: QaProjection = {
            projection_id: randomUUID(),
            question: asString(params.question) || "Q",
            answer: asString(params.answer) || "A",
            source_channel: asString(params.source_channel) || "zoom:support",
            source_ref: asString(params.source_ref),
            provider_key: asString(params.provider_key) || "zoom",
            channel_key: asString(params.channel_key) || "support",
            category_id: categoryId,
            category_key: category?.category_key,
            status: asStatus(params.status),
            origin: asOrigin(params.origin),
            approved_at: now,
            updated_at: now,
          };
          qaRecords.unshift(record);
          return { record } as T;
        }
        case "slm.control.qa.updateById": {
          const projectionId = asString(params.projection_id);
          const record = qaRecords.find((entry) => entry.projection_id === projectionId);
          if (!record) {
            throw new Error("qa record not found");
          }
          const question = asString(params.question);
          const answer = asString(params.answer);
          const provider = asString(params.provider_key);
          const channel = asString(params.channel_key);
          const categoryId = asString(params.category_id);
          if (question) {
            record.question = question;
          }
          if (answer) {
            record.answer = answer;
          }
          if (provider) {
            record.provider_key = provider;
          }
          if (channel) {
            record.channel_key = channel;
          }
          if (categoryId) {
            record.category_id = categoryId;
          }
          const status = asString(params.status);
          if (status === "draft" || status === "validated" || status === "archived") {
            record.status = status;
          }
          const origin = asString(params.origin);
          if (origin === "manual" || origin === "studio" || origin === "import") {
            record.origin = origin;
          }
          record.updated_at = new Date().toISOString();
          return { record } as T;
        }
        case "slm.control.qa.update": {
          const record = qaRecords[0];
          if (!record) {
            throw new Error("qa projection not found");
          }
          const question = asString(params.question);
          const answer = asString(params.answer);
          if (question) {
            record.question = question;
          }
          if (answer) {
            record.answer = answer;
          }
          record.updated_at = new Date().toISOString();
          return { record } as T;
        }
        case "slm.control.session.start":
          return {
            session: {
              session_id: sessionId,
            },
          } as T;
        case "slm.control.session.turn":
          return {
            session: {
              session_id: sessionId,
            },
            turn: {
              turn_id: "2ad03256-2e13-4f48-b554-a57bcbf70b12",
              model_answer: "SLM draft answer",
            },
            supervisor: {
              trace_id: "4c78d1fd-8f67-4efa-8d1f-c68934f2ecdb",
              final_answer: "SLM final answer",
            },
          } as T;
        case "slm.control.session.finish":
          return {
            session: {
              session_id: sessionId,
              status: "finished",
            },
          } as T;
        case "slm.control.training.enqueue":
          return {
            dataset_id: "2f54e7f1-70b5-4fe4-b217-a3eaf8dba4f9",
            run_id: "af0191ab-c6d8-412b-be4b-8f9ceef25a45",
            status: "queued",
            attempts: 1,
          } as T;
        default:
          throw new Error(`unknown method ${method}`);
      }
    };
  const gatewayClient: GatewayMethodClient = {
    request,
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
        role,
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
    categories,
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

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function asStatus(value: unknown): "draft" | "validated" | "archived" {
  const status = asString(value);
  if (status === "draft" || status === "archived") {
    return status;
  }
  return "validated";
}

function asOrigin(value: unknown): "manual" | "studio" | "import" {
  const origin = asString(value);
  if (origin === "studio" || origin === "import") {
    return origin;
  }
  return "manual";
}
