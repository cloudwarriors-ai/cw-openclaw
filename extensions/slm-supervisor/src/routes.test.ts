import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { createSlmSupervisorRouter } from "./routes.js";

function authHeader(tenantId: string): Record<string, string> {
  return { authorization: `Bearer tenant:${tenantId}` };
}

describe("slm supervisor routes", () => {
  test("returns slm_only when confidence/grounding pass", async () => {
    const router = createSlmSupervisorRouter();
    const response = await router.handle({
      method: "POST",
      path: "/v1/slm/supervisor/respond",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        channel_id: "zoom:ops",
        user_message: "How do I configure shared line appearance?",
        context_refs: ["https://docs.example/shared-line"],
      },
    });

    expect(response.status).toBe(200);
    expect((response.body as { source_path: string }).source_path).toBe("slm_only");
  });

  test("returns slm_plus_supervisor when escalation leads to edit", async () => {
    const router = createSlmSupervisorRouter();
    const response = await router.handle({
      method: "POST",
      path: "/v1/slm/supervisor/respond",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        channel_id: "zoom:ops",
        user_message: "How should we route calls?",
        context_refs: [],
      },
    });

    expect(response.status).toBe(200);
    expect((response.body as { source_path: string }).source_path).toBe("slm_plus_supervisor");
  });

  test("returns frontier_direct_fallback on supervisor reject", async () => {
    const router = createSlmSupervisorRouter();
    const response = await router.handle({
      method: "POST",
      path: "/v1/slm/supervisor/respond",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        channel_id: "zoom:ops",
        user_message: "Please answer this forbidden policy request",
        context_refs: [],
      },
    });

    expect(response.status).toBe(200);
    expect((response.body as { source_path: string }).source_path).toBe("frontier_direct_fallback");
  });

  test("rejects unauthorized requests", async () => {
    const router = createSlmSupervisorRouter();
    const response = await router.handle({
      method: "POST",
      path: "/v1/slm/supervisor/respond",
      body: {
        tenant_id: "tenant-a",
        channel_id: "zoom:ops",
        user_message: "hello",
        context_refs: [],
      },
    });

    expect(response.status).toBe(401);
  });

  test("returns tenant-scoped traces", async () => {
    const router = createSlmSupervisorRouter();

    await router.handle({
      method: "POST",
      path: "/v1/slm/supervisor/respond",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        channel_id: "zoom:ops",
        user_message: "How do I configure shared line appearance?",
        context_refs: ["https://docs.example/shared-line"],
      },
    });

    const traces = await router.handle({
      method: "GET",
      path: "/v1/slm/supervisor/traces?tenant_id=tenant-a&limit=5",
      query: new URL("http://localhost/v1/slm/supervisor/traces?tenant_id=tenant-a&limit=5")
        .searchParams,
      headers: authHeader("tenant-a"),
    });

    expect(traces.status).toBe(200);
    expect((traces.body as { traces: unknown[] }).traces.length).toBeGreaterThan(0);
  });

  test("records feedback for a tenant trace", async () => {
    const router = createSlmSupervisorRouter();
    const response = await router.handle({
      method: "POST",
      path: "/v1/slm/supervisor/respond",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        channel_id: "zoom:ops",
        user_message: "How do I configure shared line appearance?",
        context_refs: ["https://docs.example/shared-line"],
      },
    });
    const traceId = (response.body as { trace_id: string }).trace_id;

    const feedbackResponse = await router.handle({
      method: "POST",
      path: "/v1/slm/supervisor/feedback",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        trace_id: traceId,
        feedback_type: "thumbs_up",
        comment: "This resolved the issue",
      },
    });

    expect(feedbackResponse.status).toBe(200);
    expect((feedbackResponse.body as { feedback_id: string }).feedback_id).toBeTruthy();
    expect((feedbackResponse.body as { trace_id: string }).trace_id).toBe(traceId);
  });

  test("rejects feedback tenant mismatch", async () => {
    const router = createSlmSupervisorRouter();
    const response = await router.handle({
      method: "POST",
      path: "/v1/slm/supervisor/respond",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        channel_id: "zoom:ops",
        user_message: "How do I configure shared line appearance?",
        context_refs: ["https://docs.example/shared-line"],
      },
    });
    const traceId = (response.body as { trace_id: string }).trace_id;

    const feedbackResponse = await router.handle({
      method: "POST",
      path: "/v1/slm/supervisor/feedback",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-b",
        trace_id: traceId,
        feedback_type: "thumbs_down",
      },
    });

    expect(feedbackResponse.status).toBe(403);
  });

  test("rejects feedback for unknown trace id", async () => {
    const router = createSlmSupervisorRouter();
    const traceId = randomUUID();
    const feedbackResponse = await router.handle({
      method: "POST",
      path: "/v1/slm/supervisor/feedback",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        trace_id: traceId,
        feedback_type: "thumbs_down",
      },
    });

    expect(feedbackResponse.status).toBe(404);
  });

  test("returns 404 when trace exists for another tenant", async () => {
    const router = createSlmSupervisorRouter();
    const response = await router.handle({
      method: "POST",
      path: "/v1/slm/supervisor/respond",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        channel_id: "zoom:ops",
        user_message: "How do I configure shared line appearance?",
        context_refs: ["https://docs.example/shared-line"],
      },
    });
    const traceId = (response.body as { trace_id: string }).trace_id;

    const feedbackResponse = await router.handle({
      method: "POST",
      path: "/v1/slm/supervisor/feedback",
      headers: authHeader("tenant-b"),
      body: {
        tenant_id: "tenant-b",
        trace_id: traceId,
        feedback_type: "thumbs_down",
      },
    });

    expect(feedbackResponse.status).toBe(404);
  });

  test("validates feedback payload", async () => {
    const router = createSlmSupervisorRouter();
    const feedbackResponse = await router.handle({
      method: "POST",
      path: "/v1/slm/supervisor/feedback",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        trace_id: "not-a-uuid",
        feedback_type: "thumbs_sideways",
      },
    });

    expect(feedbackResponse.status).toBe(400);
  });
});
