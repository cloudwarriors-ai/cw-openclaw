const state = {
  me: null,
  categories: [],
  qaRecords: [],
  selectedProjectionId: null,
  activeSessionId: null,
  activeSessionQuestion: "",
  lastSessionTurn: null,
  traces: [],
};

const els = {
  loginPanel: document.getElementById("login-panel"),
  dashboardPanel: document.getElementById("dashboard-panel"),
  loginForm: document.getElementById("login-form"),
  loginError: document.getElementById("login-error"),
  meLine: document.getElementById("me-line"),
  logoutButton: document.getElementById("logout-button"),

  qaRefresh: document.getElementById("qa-refresh"),
  qaQuery: document.getElementById("qa-query"),
  qaTableBody: document.getElementById("qa-table-body"),
  qaEmpty: document.getElementById("qa-empty"),

  filterProvider: document.getElementById("filter-provider"),
  filterChannel: document.getElementById("filter-channel"),
  filterCategory: document.getElementById("filter-category"),
  filterStatus: document.getElementById("filter-status"),

  categoryCreateForm: document.getElementById("category-create-form"),
  categoryCreateProvider: document.getElementById("category-create-provider"),
  categoryCreateChannel: document.getElementById("category-create-channel"),
  categoryCreateKey: document.getElementById("category-create-key"),
  categoryCreateName: document.getElementById("category-create-name"),
  categoryCreateOrder: document.getElementById("category-create-order"),

  categoryUpdateForm: document.getElementById("category-update-form"),
  categoryUpdateId: document.getElementById("category-update-id"),
  categoryUpdateName: document.getElementById("category-update-name"),
  categoryUpdateActive: document.getElementById("category-update-active"),
  categoryUpdateOrder: document.getElementById("category-update-order"),
  categoryStatus: document.getElementById("category-status"),

  qaCreateForm: document.getElementById("qa-create-form"),
  qaCreateProvider: document.getElementById("qa-create-provider"),
  qaCreateChannel: document.getElementById("qa-create-channel"),
  qaCreateCategory: document.getElementById("qa-create-category"),
  qaCreateStatus: document.getElementById("qa-create-status"),
  qaCreateQuestion: document.getElementById("qa-create-question"),
  qaCreateAnswer: document.getElementById("qa-create-answer"),

  qaUpdateForm: document.getElementById("qa-update-form"),
  qaProjectionId: document.getElementById("qa-projection-id"),
  qaEditProvider: document.getElementById("qa-edit-provider"),
  qaEditChannel: document.getElementById("qa-edit-channel"),
  qaEditCategory: document.getElementById("qa-edit-category"),
  qaEditStatus: document.getElementById("qa-edit-status"),
  qaQuestion: document.getElementById("qa-question"),
  qaAnswer: document.getElementById("qa-answer"),
  qaUpdateStatus: document.getElementById("qa-update-status"),

  sessionStartForm: document.getElementById("session-start-form"),
  sessionTurnForm: document.getElementById("session-turn-form"),
  sessionQuestion: document.getElementById("session-question"),
  sessionPrompt: document.getElementById("session-prompt"),
  sessionEditedAnswer: document.getElementById("session-edited-answer"),
  sessionFinish: document.getElementById("session-finish"),
  sessionId: document.getElementById("session-id"),
  sessionOutput: document.getElementById("session-output"),

  sessionSaveForm: document.getElementById("session-save-form"),
  sessionSaveProvider: document.getElementById("session-save-provider"),
  sessionSaveChannel: document.getElementById("session-save-channel"),
  sessionSaveCategory: document.getElementById("session-save-category"),
  sessionSaveStatus: document.getElementById("session-save-status-select"),
  sessionSaveStatusLine: document.getElementById("session-save-result"),

  trainingForm: document.getElementById("training-form"),
  trainingBaseModel: document.getElementById("training-base-model"),
  trainingSource: document.getElementById("training-source"),
  trainingProvider: document.getElementById("training-provider"),
  trainingChannel: document.getElementById("training-channel"),
  trainingCategory: document.getElementById("training-category"),
  trainingStatus: document.getElementById("training-status"),
  trainingSplitSeed: document.getElementById("training-split-seed"),
  trainingOutput: document.getElementById("training-output"),

  traceList: document.getElementById("trace-list"),
};

function toJson(value) {
  return JSON.stringify(value, null, 2);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeKey(value) {
  return (value || "").trim().toLowerCase();
}

function slugify(value) {
  return normalizeKey(value).replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function isFactoryRole(role) {
  return role === "trainer" || role === "admin";
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function canManageQaLibrary() {
  return isFactoryRole(state.me?.role || "operator");
}

function renderTraceList() {
  els.traceList.innerHTML = "";
  const items = state.traces.slice(0, 30);
  for (const item of items) {
    const node = document.createElement("div");
    node.className = "trace-item";
    node.innerHTML = [
      `<div class="trace-meta">${escapeHtml(item.method)} ${escapeHtml(item.url)} · status ${escapeHtml(item.status)} · ${escapeHtml(item.durationMs)}ms</div>`,
      `<details class="trace-collapsible">`,
      `<summary>Data In</summary>`,
      `<pre class="json-box">${escapeHtml(toJson(item.request))}</pre>`,
      `</details>`,
      `<details class="trace-collapsible">`,
      `<summary>Data Out</summary>`,
      `<pre class="json-box">${escapeHtml(toJson(item.response))}</pre>`,
      `</details>`,
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

function applyRoleVisibility() {
  const role = state.me?.role || "operator";
  const factoryEnabled = isFactoryRole(role);
  for (const node of document.querySelectorAll(".factory-only")) {
    node.classList.toggle("hidden", !factoryEnabled);
  }
}

function renderMe() {
  if (!state.me) {
    els.meLine.textContent = "";
    return;
  }
  const name = state.me.display_name || state.me.username;
  const role = state.me.role || "operator";
  els.meLine.textContent = `Signed in as ${name} · role ${role} · tenant ${state.me.tenant_id}`;
}

function setSelectOptions(select, entries, options = {}) {
  if (!select) {
    return;
  }
  const { includeAll = true, allLabel = "All", keepValue = true } = options;
  const current = keepValue ? select.value : "";
  select.innerHTML = "";

  if (includeAll) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = allLabel;
    select.appendChild(option);
  }

  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label;
    select.appendChild(option);
  }

  if (current && entries.some((entry) => entry.value === current)) {
    select.value = current;
    return;
  }

  if (!includeAll && entries.length > 0) {
    select.value = entries[0].value;
  }
}

function categoryLabel(category) {
  return `${category.provider_key}/${category.channel_key}/${category.category_key} · ${category.display_name}`;
}

function providerOptions() {
  const keys = [...new Set(state.categories.map((entry) => entry.provider_key))].sort();
  return keys.map((value) => ({ value, label: value }));
}

function channelOptions(providerKey) {
  const keys = [...new Set(
    state.categories
      .filter((entry) => !providerKey || entry.provider_key === providerKey)
      .map((entry) => entry.channel_key),
  )].sort();
  return keys.map((value) => ({ value, label: value }));
}

function categoryOptions(providerKey, channelKey) {
  return state.categories
    .filter((entry) => (!providerKey || entry.provider_key === providerKey) && (!channelKey || entry.channel_key === channelKey))
    .sort((a, b) => a.sort_order - b.sort_order || a.display_name.localeCompare(b.display_name))
    .map((entry) => ({ value: entry.category_id, label: categoryLabel(entry) }));
}

function selectedFilterProvider() {
  return normalizeKey(els.filterProvider.value);
}

function selectedFilterChannel() {
  return normalizeKey(els.filterChannel.value);
}

function refreshTaxonomySelectors() {
  const providers = providerOptions();
  setSelectOptions(els.filterProvider, providers, { includeAll: true, allLabel: "All providers" });

  const providerKey = selectedFilterProvider();
  const channels = channelOptions(providerKey);
  setSelectOptions(els.filterChannel, channels, { includeAll: true, allLabel: "All channels" });

  const channelKey = selectedFilterChannel();
  const categories = categoryOptions(providerKey, channelKey);
  setSelectOptions(els.filterCategory, categories, { includeAll: true, allLabel: "All categories" });

  setSelectOptions(
    els.categoryUpdateId,
    state.categories
      .slice()
      .sort((a, b) => a.provider_key.localeCompare(b.provider_key) || a.channel_key.localeCompare(b.channel_key) || a.sort_order - b.sort_order)
      .map((entry) => ({ value: entry.category_id, label: categoryLabel(entry) })),
    { includeAll: false, keepValue: true },
  );

  const defaultCreateOptions = categoryOptions(
    normalizeKey(els.qaCreateProvider.value) || providerKey,
    normalizeKey(els.qaCreateChannel.value) || channelKey,
  );
  setSelectOptions(els.qaCreateCategory, defaultCreateOptions, {
    includeAll: false,
    keepValue: true,
  });

  const editOptions = categoryOptions(
    normalizeKey(els.qaEditProvider.value) || providerKey,
    normalizeKey(els.qaEditChannel.value) || channelKey,
  );
  setSelectOptions(els.qaEditCategory, editOptions, { includeAll: true, allLabel: "No change" });

  const sessionSaveOptions = categoryOptions(
    normalizeKey(els.sessionSaveProvider.value) || providerKey,
    normalizeKey(els.sessionSaveChannel.value) || channelKey,
  );
  setSelectOptions(els.sessionSaveCategory, sessionSaveOptions, { includeAll: false, keepValue: true });

  const trainingOptions = categoryOptions(
    normalizeKey(els.trainingProvider.value) || providerKey,
    normalizeKey(els.trainingChannel.value) || channelKey,
  );
  setSelectOptions(els.trainingCategory, trainingOptions, { includeAll: true, allLabel: "All categories" });

  if (!els.qaCreateProvider.value && providerKey) {
    els.qaCreateProvider.value = providerKey;
  }
  if (!els.qaCreateChannel.value && channelKey) {
    els.qaCreateChannel.value = channelKey;
  }
  if (!els.sessionSaveProvider.value && providerKey) {
    els.sessionSaveProvider.value = providerKey;
  }
  if (!els.sessionSaveChannel.value && channelKey) {
    els.sessionSaveChannel.value = channelKey;
  }
}

function categoryDisplayName(record) {
  if (!record?.category_id) {
    return record?.category_key || "";
  }
  const category = state.categories.find((entry) => entry.category_id === record.category_id);
  if (category) {
    return category.display_name;
  }
  return record.category_key || record.category_id;
}

function appendQaCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = String(value ?? "");
  row.appendChild(cell);
}

function qaRecordMatchesCurrentFilters(record) {
  const providerKey = selectedFilterProvider();
  if (providerKey && normalizeKey(record.provider_key) !== providerKey) {
    return false;
  }
  const channelKey = selectedFilterChannel();
  if (channelKey && normalizeKey(record.channel_key) !== channelKey) {
    return false;
  }
  const categoryId = els.filterCategory.value;
  if (categoryId && record.category_id !== categoryId) {
    return false;
  }
  const status = els.filterStatus.value;
  if (status && record.status !== status) {
    return false;
  }
  const query = els.qaQuery.value.trim().toLowerCase();
  if (!query) {
    return true;
  }
  return `${record.question || ""}\n${record.answer || ""}`.toLowerCase().includes(query);
}

function applyUpdatedQaRecord(record) {
  const projectionId = record?.projection_id;
  if (!projectionId) {
    return;
  }
  const index = state.qaRecords.findIndex((entry) => entry.projection_id === projectionId);
  const matches = qaRecordMatchesCurrentFilters(record);

  if (!matches) {
    if (index >= 0) {
      state.qaRecords.splice(index, 1);
    }
    return;
  }

  if (index >= 0) {
    state.qaRecords[index] = {
      ...state.qaRecords[index],
      ...record,
    };
    return;
  }

  state.qaRecords.unshift(record);
}

function clearSelectedQaRecord(projectionId) {
  if (state.selectedProjectionId !== projectionId) {
    return;
  }
  state.selectedProjectionId = null;
  els.qaProjectionId.value = "";
  els.qaQuestion.value = "";
  els.qaAnswer.value = "";
}

function statusFilterVisibilityHint(nextStatus) {
  const filterStatus = els.filterStatus.value;
  if (!nextStatus || !filterStatus || filterStatus === nextStatus) {
    return "";
  }
  return `Record moved to ${nextStatus} and is hidden by current status filter (${filterStatus}).`;
}

async function updateQaRecord(projectionId, updates, successMessage) {
  const response = await apiRequest("PUT", "/api/slm/qa", {
    projection_id: projectionId,
    ...updates,
  });
  const updatedRecord =
    response && typeof response === "object" && response.record && typeof response.record === "object"
      ? response.record
      : null;
  if (updatedRecord?.projection_id === projectionId) {
    applyUpdatedQaRecord(updatedRecord);
    if (qaRecordMatchesCurrentFilters(updatedRecord)) {
      selectQaRecord(updatedRecord);
    } else {
      clearSelectedQaRecord(projectionId);
      renderQaTable();
    }
  }

  let refreshError = null;
  try {
    await refreshQa();
  } catch (error) {
    refreshError = error;
  }

  const found = state.qaRecords.find((entry) => entry.projection_id === projectionId);
  if (found) {
    selectQaRecord(found);
  } else {
    clearSelectedQaRecord(projectionId);
    renderQaTable();
  }

  if (refreshError) {
    els.qaUpdateStatus.textContent = `${successMessage} (refresh failed: ${toErrorMessage(refreshError)})`;
    return;
  }

  const hint = statusFilterVisibilityHint(
    updatedRecord?.status && typeof updatedRecord.status === "string" ? updatedRecord.status : undefined,
  );
  if (hint) {
    els.qaUpdateStatus.textContent = `${successMessage} ${hint}`;
    return;
  }
  els.qaUpdateStatus.textContent = successMessage;
}

function createQaActionButton(label, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const wrapper = button.closest(".qa-actions");
    const actionButtons = wrapper ? wrapper.querySelectorAll("button") : [button];
    for (const actionButton of actionButtons) {
      actionButton.disabled = true;
    }
    try {
      await action();
    } catch (error) {
      els.qaUpdateStatus.textContent = toErrorMessage(error);
    } finally {
      for (const actionButton of actionButtons) {
        actionButton.disabled = false;
      }
    }
  });
  return button;
}

function createQaActionsCell(record) {
  const cell = document.createElement("td");
  cell.className = "qa-actions-cell";
  const projectionId = record.projection_id || "";

  if (!canManageQaLibrary()) {
    const note = document.createElement("span");
    note.className = "muted";
    note.textContent = "Read only";
    cell.appendChild(note);
    return cell;
  }

  const actions = document.createElement("div");
  actions.className = "qa-actions";

  const editButton = createQaActionButton("Edit", "qa-action qa-action-edit button-secondary", async () => {
    selectQaRecord(record);
    els.qaUpdateForm.classList.add("focus-ring");
    els.qaUpdateForm.scrollIntoView({ behavior: "smooth", block: "start" });
    els.qaQuestion.focus();
    setTimeout(() => {
      els.qaUpdateForm.classList.remove("focus-ring");
    }, 1200);
    els.qaUpdateStatus.textContent = "Record selected. Edit it in the Update Selected Q&A form below.";
  });

  const validateButton = createQaActionButton(
    "Validate",
    "qa-action qa-action-validate",
    async () => {
      if (!projectionId) {
        throw new Error("projection id missing");
      }
      await updateQaRecord(projectionId, { status: "validated" }, "Q&A validated.");
    },
  );
  validateButton.disabled = !projectionId || record.status === "validated";

  const archiveButton = createQaActionButton(
    "Archive",
    "qa-action qa-action-archive",
    async () => {
      if (!projectionId) {
        throw new Error("projection id missing");
      }
      await updateQaRecord(projectionId, { status: "archived" }, "Q&A archived.");
    },
  );
  archiveButton.disabled = !projectionId || record.status === "archived";

  actions.append(editButton, validateButton, archiveButton);
  cell.appendChild(actions);
  return cell;
}

function renderQaTable() {
  els.qaTableBody.innerHTML = "";
  for (const record of state.qaRecords) {
    const row = document.createElement("tr");
    if (record.projection_id === state.selectedProjectionId) {
      row.classList.add("selected");
    }
    appendQaCell(row, record.updated_at || "");
    appendQaCell(row, record.provider_key || "");
    appendQaCell(row, record.channel_key || "");
    appendQaCell(row, categoryDisplayName(record));
    appendQaCell(row, record.status || "");
    appendQaCell(row, record.question || "");
    appendQaCell(row, record.answer || "");
    row.appendChild(createQaActionsCell(record));
    row.addEventListener("click", () => selectQaRecord(record));
    els.qaTableBody.appendChild(row);
  }
  els.qaEmpty.classList.toggle("hidden", state.qaRecords.length > 0);
}

function selectQaRecord(record) {
  state.selectedProjectionId = record.projection_id || null;
  els.qaProjectionId.value = record.projection_id || "";
  els.qaQuestion.value = record.question || "";
  els.qaAnswer.value = record.answer || "";
  els.qaEditProvider.value = record.provider_key || "";
  els.qaEditChannel.value = record.channel_key || "";
  refreshTaxonomySelectors();
  if (record.category_id) {
    els.qaEditCategory.value = record.category_id;
  }
  els.qaEditStatus.value = record.status || "";
  renderQaTable();
}

function setActiveSessionId(sessionId) {
  state.activeSessionId = sessionId;
  els.sessionId.textContent = sessionId ? `Active session: ${sessionId}` : "No active session";
}

function currentQaListParams() {
  const providerKey = selectedFilterProvider();
  const channelKey = selectedFilterChannel();
  const categoryId = els.filterCategory.value;
  const status = els.filterStatus.value;
  const query = els.qaQuery.value.trim();
  const params = new URLSearchParams();
  if (providerKey) {
    params.set("provider_key", providerKey);
  }
  if (channelKey) {
    params.set("channel_key", channelKey);
  }
  if (categoryId) {
    params.set("category_id", categoryId);
  }
  if (status) {
    params.set("status", status);
  }
  if (query) {
    params.set("query", query);
  }
  params.set("limit", "200");
  return params;
}

async function refreshCategories() {
  const params = new URLSearchParams();
  params.set("include_inactive", "true");
  params.set("limit", "200");
  const data = await apiRequest("GET", `/api/slm/categories?${params.toString()}`);
  state.categories = Array.isArray(data.records) ? data.records : [];
  refreshTaxonomySelectors();
}

async function refreshQa() {
  const data = await apiRequest("GET", `/api/slm/qa?${currentQaListParams().toString()}`);
  state.qaRecords = Array.isArray(data.records) ? data.records : [];
  if (state.selectedProjectionId) {
    const selected = state.qaRecords.find((entry) => entry.projection_id === state.selectedProjectionId);
    if (!selected) {
      state.selectedProjectionId = null;
      els.qaProjectionId.value = "";
    }
  }
  renderQaTable();
}

async function refreshAll() {
  await refreshCategories();
  await refreshQa();
}

async function bootstrap() {
  try {
    state.me = await apiRequest("GET", "/api/auth/me");
    setAuthedView(true);
    renderMe();
    applyRoleVisibility();
    await refreshAll();
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
    applyRoleVisibility();
    await refreshAll();
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
    state.categories = [];
    state.selectedProjectionId = null;
    setActiveSessionId(null);
    renderQaTable();
    setAuthedView(false);
  }
});

els.qaRefresh.addEventListener("click", async () => {
  await refreshAll();
});

for (const node of [els.filterProvider, els.filterChannel, els.filterCategory, els.filterStatus]) {
  node.addEventListener("change", async () => {
    if (node === els.filterProvider || node === els.filterChannel) {
      refreshTaxonomySelectors();
    }
    await refreshQa();
  });
}

els.qaQuery.addEventListener("change", async () => {
  await refreshQa();
});

for (const node of [els.qaCreateProvider, els.qaCreateChannel, els.qaEditProvider, els.qaEditChannel, els.sessionSaveProvider, els.sessionSaveChannel, els.trainingProvider, els.trainingChannel]) {
  node.addEventListener("change", () => {
    refreshTaxonomySelectors();
  });
}

els.categoryCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.categoryStatus.textContent = "";
  try {
    const providerKey = slugify(els.categoryCreateProvider.value);
    const channelKey = slugify(els.categoryCreateChannel.value);
    const categoryKey = slugify(els.categoryCreateKey.value);
    const displayName = els.categoryCreateName.value.trim();
    const sortOrder = Number.parseInt(els.categoryCreateOrder.value.trim(), 10);

    if (!providerKey || !channelKey || !categoryKey || !displayName) {
      throw new Error("provider/channel/category keys and display name are required");
    }

    await apiRequest("POST", "/api/slm/categories", {
      provider_key: providerKey,
      channel_key: channelKey,
      category_key: categoryKey,
      display_name: displayName,
      sort_order: Number.isFinite(sortOrder) ? sortOrder : undefined,
    });

    els.categoryStatus.textContent = "Category created.";
    els.categoryCreateForm.reset();
    els.categoryCreateOrder.value = "1000";
    await refreshCategories();
  } catch (error) {
    els.categoryStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

els.categoryUpdateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.categoryStatus.textContent = "";
  try {
    const categoryId = els.categoryUpdateId.value;
    if (!categoryId) {
      throw new Error("select a category to update");
    }

    const payload = {};
    const displayName = els.categoryUpdateName.value.trim();
    if (displayName) {
      payload.display_name = displayName;
    }

    const active = els.categoryUpdateActive.value;
    if (active === "true") {
      payload.is_active = true;
    } else if (active === "false") {
      payload.is_active = false;
    }

    const sortOrderRaw = els.categoryUpdateOrder.value.trim();
    if (sortOrderRaw) {
      const sortOrder = Number.parseInt(sortOrderRaw, 10);
      if (!Number.isFinite(sortOrder)) {
        throw new Error("sort order must be an integer");
      }
      payload.sort_order = sortOrder;
    }

    if (Object.keys(payload).length < 1) {
      throw new Error("provide at least one field to update");
    }

    await apiRequest("PATCH", `/api/slm/categories/${encodeURIComponent(categoryId)}`, payload);
    els.categoryStatus.textContent = "Category updated.";
    els.categoryUpdateName.value = "";
    els.categoryUpdateActive.value = "";
    els.categoryUpdateOrder.value = "";
    await refreshCategories();
    await refreshQa();
  } catch (error) {
    els.categoryStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

els.qaCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.qaUpdateStatus.textContent = "";
  try {
    const providerKey = slugify(els.qaCreateProvider.value);
    const channelKey = slugify(els.qaCreateChannel.value);
    const categoryId = els.qaCreateCategory.value;
    const question = els.qaCreateQuestion.value.trim();
    const answer = els.qaCreateAnswer.value.trim();

    if (!providerKey || !channelKey || !categoryId || !question || !answer) {
      throw new Error("provider/channel/category/question/answer are required");
    }

    const response = await apiRequest("POST", "/api/slm/qa", {
      provider_key: providerKey,
      channel_key: channelKey,
      category_id: categoryId,
      status: els.qaCreateStatus.value || undefined,
      origin: "manual",
      question,
      answer,
      source_channel: `${providerKey}:${channelKey}`,
    });

    els.qaUpdateStatus.textContent = "Q&A created.";
    els.qaCreateQuestion.value = "";
    els.qaCreateAnswer.value = "";
    await refreshQa();
    const created = response?.record;
    if (created?.projection_id) {
      const found = state.qaRecords.find((entry) => entry.projection_id === created.projection_id);
      if (found) {
        selectQaRecord(found);
      }
    }
  } catch (error) {
    els.qaUpdateStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

els.qaUpdateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const projectionId = els.qaProjectionId.value.trim();
  if (!projectionId) {
    els.qaUpdateStatus.textContent = "Select a Q&A record first.";
    return;
  }

  try {
    const payload = {};

    const providerKey = slugify(els.qaEditProvider.value);
    if (providerKey) {
      payload.provider_key = providerKey;
    }

    const channelKey = slugify(els.qaEditChannel.value);
    if (channelKey) {
      payload.channel_key = channelKey;
    }

    const categoryId = els.qaEditCategory.value;
    if (categoryId) {
      payload.category_id = categoryId;
    }

    if (els.qaEditStatus.value) {
      payload.status = els.qaEditStatus.value;
    }

    const question = els.qaQuestion.value.trim();
    if (question) {
      payload.question = question;
    }

    const answer = els.qaAnswer.value.trim();
    if (answer) {
      payload.answer = answer;
    }

    await updateQaRecord(projectionId, payload, "Q&A updated.");
  } catch (error) {
    els.qaUpdateStatus.textContent = toErrorMessage(error);
  }
});

els.sessionStartForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const question = els.sessionQuestion.value.trim();
    const data = await apiRequest("POST", "/api/slm/session/start", {
      question,
    });
    const sessionId = data?.session?.session_id;
    state.activeSessionQuestion = question;
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
    state.lastSessionTurn = data;
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

els.sessionSaveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.sessionSaveStatusLine.textContent = "";
  try {
    const question = state.activeSessionQuestion || els.sessionQuestion.value.trim();
    const edited = els.sessionEditedAnswer.value.trim();
    const modelAnswer = state.lastSessionTurn?.supervisor?.final_answer || state.lastSessionTurn?.turn?.model_answer;
    const answer = edited || modelAnswer || "";

    if (!question || !answer) {
      throw new Error("run at least one studio turn and provide an edited or model answer");
    }

    const providerKey = slugify(els.sessionSaveProvider.value);
    const channelKey = slugify(els.sessionSaveChannel.value);
    const categoryId = els.sessionSaveCategory.value;

    if (!providerKey || !channelKey || !categoryId) {
      throw new Error("provider/channel/category are required");
    }

    await apiRequest("POST", "/api/slm/qa", {
      question,
      answer,
      provider_key: providerKey,
      channel_key: channelKey,
      category_id: categoryId,
      status: els.sessionSaveStatus.value || "validated",
      origin: "studio",
      source_channel: `${providerKey}:${channelKey}`,
    });

    els.sessionSaveStatusLine.textContent = "Studio correction saved to library.";
    await refreshQa();
  } catch (error) {
    els.sessionSaveStatusLine.textContent = error instanceof Error ? error.message : String(error);
  }
});

els.trainingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const splitSeedRaw = els.trainingSplitSeed.value.trim();
    const splitSeed = splitSeedRaw ? Number.parseInt(splitSeedRaw, 10) : undefined;

    const payload = {
      base_model: els.trainingBaseModel.value.trim(),
      source: els.trainingSource.value || undefined,
      provider_key: slugify(els.trainingProvider.value) || undefined,
      channel_key: slugify(els.trainingChannel.value) || undefined,
      category_id: els.trainingCategory.value || undefined,
      status: els.trainingStatus.value || undefined,
      split_seed: Number.isFinite(splitSeed) ? splitSeed : undefined,
    };

    const data = await apiRequest("POST", "/api/slm/training/enqueue", payload);
    els.trainingOutput.textContent = toJson(data);
  } catch (error) {
    els.trainingOutput.textContent = String(error);
  }
});

void bootstrap();
