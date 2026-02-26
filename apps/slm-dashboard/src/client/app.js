const state = {
  me: null,
  qaRecords: [],
  activeSessionId: null,
  traces: [],
};

const els = {
  loginPanel: document.getElementById("login-panel"),
  dashboardPanel: document.getElementById("dashboard-panel"),
  loginForm: document.getElementById("login-form"),
  loginError: document.getElementById("login-error"),
  meLine: document.getElementById("me-line"),
  logoutButton: document.getElementById("logout-button"),
  qaQuery: document.getElementById("qa-query"),
  qaRefresh: document.getElementById("qa-refresh"),
  qaTableBody: document.getElementById("qa-table-body"),
  qaEmpty: document.getElementById("qa-empty"),
  qaUpdateForm: document.getElementById("qa-update-form"),
  qaProjectionId: document.getElementById("qa-projection-id"),
  qaQuestion: document.getElementById("qa-question"),
  qaAnswer: document.getElementById("qa-answer"),
  qaSourceChannel: document.getElementById("qa-source-channel"),
  qaSourceRef: document.getElementById("qa-source-ref"),
  qaUpdateStatus: document.getElementById("qa-update-status"),
  sessionStartForm: document.getElementById("session-start-form"),
  sessionTurnForm: document.getElementById("session-turn-form"),
  sessionQuestion: document.getElementById("session-question"),
  sessionPrompt: document.getElementById("session-prompt"),
  sessionEditedAnswer: document.getElementById("session-edited-answer"),
  sessionFinish: document.getElementById("session-finish"),
  sessionId: document.getElementById("session-id"),
  sessionOutput: document.getElementById("session-output"),
  trainingForm: document.getElementById("training-form"),
  trainingBaseModel: document.getElementById("training-base-model"),
  trainingSplitSeed: document.getElementById("training-split-seed"),
  trainingOutput: document.getElementById("training-output"),
  traceList: document.getElementById("trace-list"),
};

function toJson(value) {
  return JSON.stringify(value, null, 2);
}

function renderTraceList() {
  els.traceList.innerHTML = "";
  const items = state.traces.slice(0, 30);
  for (const item of items) {
    const node = document.createElement("div");
    node.className = "trace-item";
    node.innerHTML = [
      `<div class="trace-meta">${item.method} ${item.url} · status ${item.status} · ${item.durationMs}ms</div>`,
      `<pre class="json-box">request:\n${toJson(item.request)}</pre>`,
      `<pre class="json-box">response:\n${toJson(item.response)}</pre>`,
    ].join("");
    els.traceList.appendChild(node);
  }
}

async function apiRequest(method, url, body) {
  const startedAt = Date.now();
  const headers = {};
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  if (requestBody !== undefined) {
    headers["content-type"] = "application/json";
  }
  let responseBody = null;
  let status = 0;
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: requestBody,
      credentials: "same-origin",
    });
    status = response.status;
    const contentType = response.headers.get("content-type") || "";
    responseBody = contentType.includes("application/json") ? await response.json() : await response.text();
    state.traces.unshift({
      method,
      url,
      request: body ?? null,
      response: responseBody,
      status,
      durationMs: Date.now() - startedAt,
    });
    renderTraceList();
    if (!response.ok || !responseBody || responseBody.ok !== true) {
      const message = responseBody?.error?.message || `request failed (${response.status})`;
      throw new Error(message);
    }
    return responseBody.data;
  } catch (error) {
    if (status === 0) {
      state.traces.unshift({
        method,
        url,
        request: body ?? null,
        response: { error: String(error) },
        status: 0,
        durationMs: Date.now() - startedAt,
      });
      renderTraceList();
    }
    throw error;
  }
}

function setAuthedView(authed) {
  els.loginPanel.classList.toggle("hidden", authed);
  els.dashboardPanel.classList.toggle("hidden", !authed);
}

function renderMe() {
  if (!state.me) {
    els.meLine.textContent = "";
    return;
  }
  const name = state.me.display_name || state.me.username;
  els.meLine.textContent = `Signed in as ${name} · tenant ${state.me.tenant_id}`;
}

function renderQaTable() {
  els.qaTableBody.innerHTML = "";
  for (const record of state.qaRecords) {
    const row = document.createElement("tr");
    row.innerHTML = [
      `<td>${record.updated_at || ""}</td>`,
      `<td>${record.question || ""}</td>`,
      `<td>${record.answer || ""}</td>`,
    ].join("");
    row.addEventListener("click", () => selectQaRecord(record));
    els.qaTableBody.appendChild(row);
  }
  els.qaEmpty.classList.toggle("hidden", state.qaRecords.length > 0);
}

function selectQaRecord(record) {
  els.qaProjectionId.value = record.projection_id || "";
  els.qaQuestion.value = record.question || "";
  els.qaAnswer.value = record.answer || "";
  els.qaSourceChannel.value = record.source_channel || "";
  els.qaSourceRef.value = record.source_ref || "";
}

function setActiveSessionId(sessionId) {
  state.activeSessionId = sessionId;
  els.sessionId.textContent = sessionId ? `Active session: ${sessionId}` : "No active session";
}

async function refreshQa() {
  const query = els.qaQuery.value.trim();
  const data = await apiRequest("GET", `/api/slm/qa${query ? `?query=${encodeURIComponent(query)}` : ""}`);
  state.qaRecords = Array.isArray(data.records) ? data.records : [];
  renderQaTable();
}

async function bootstrap() {
  try {
    state.me = await apiRequest("GET", "/api/auth/me");
    setAuthedView(true);
    renderMe();
    await refreshQa();
  } catch {
    state.me = null;
    setAuthedView(false);
  }
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.loginError.textContent = "";
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  try {
    state.me = await apiRequest("POST", "/api/auth/login", { username, password });
    setAuthedView(true);
    renderMe();
    await refreshQa();
  } catch (error) {
    els.loginError.textContent = error instanceof Error ? error.message : String(error);
  }
});

els.logoutButton.addEventListener("click", async () => {
  try {
    await apiRequest("POST", "/api/auth/logout", {});
  } finally {
    state.me = null;
    state.qaRecords = [];
    renderQaTable();
    setActiveSessionId(null);
    setAuthedView(false);
  }
});

els.qaRefresh.addEventListener("click", async () => {
  await refreshQa();
});

els.qaUpdateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const projectionId = els.qaProjectionId.value.trim();
  if (!projectionId) {
    els.qaUpdateStatus.textContent = "Select a Q&A record first.";
    return;
  }
  try {
    const payload = {
      question: els.qaQuestion.value.trim(),
      answer: els.qaAnswer.value.trim(),
      source_channel: els.qaSourceChannel.value.trim() || undefined,
      source_ref: els.qaSourceRef.value.trim() || undefined,
    };
    const data = await apiRequest("PUT", `/api/slm/qa/${projectionId}`, payload);
    els.qaUpdateStatus.textContent = "Answer updated.";
    if (data?.record) {
      selectQaRecord(data.record);
    }
    await refreshQa();
  } catch (error) {
    els.qaUpdateStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

els.sessionStartForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await apiRequest("POST", "/api/slm/session/start", {
      question: els.sessionQuestion.value.trim(),
    });
    const sessionId = data?.session?.session_id;
    setActiveSessionId(sessionId || null);
    els.sessionOutput.textContent = toJson(data);
  } catch (error) {
    els.sessionOutput.textContent = String(error);
  }
});

els.sessionTurnForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.activeSessionId) {
    els.sessionOutput.textContent = "Start a session first.";
    return;
  }
  try {
    const data = await apiRequest("POST", `/api/slm/session/${state.activeSessionId}/turn`, {
      user_prompt: els.sessionPrompt.value.trim(),
      edited_answer: els.sessionEditedAnswer.value.trim() || undefined,
    });
    els.sessionOutput.textContent = toJson(data);
  } catch (error) {
    els.sessionOutput.textContent = String(error);
  }
});

els.sessionFinish.addEventListener("click", async () => {
  if (!state.activeSessionId) {
    return;
  }
  try {
    const data = await apiRequest("POST", `/api/slm/session/${state.activeSessionId}/finish`, {});
    els.sessionOutput.textContent = toJson(data);
    setActiveSessionId(null);
  } catch (error) {
    els.sessionOutput.textContent = String(error);
  }
});

els.trainingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const splitSeedRaw = els.trainingSplitSeed.value.trim();
    const splitSeed = splitSeedRaw ? Number.parseInt(splitSeedRaw, 10) : undefined;
    const data = await apiRequest("POST", "/api/slm/training/enqueue", {
      base_model: els.trainingBaseModel.value.trim(),
      split_seed: Number.isFinite(splitSeed) ? splitSeed : undefined,
    });
    els.trainingOutput.textContent = toJson(data);
  } catch (error) {
    els.trainingOutput.textContent = String(error);
  }
});

void bootstrap();
