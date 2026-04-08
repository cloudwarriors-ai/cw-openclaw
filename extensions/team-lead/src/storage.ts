import { randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  renameSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  ProjectStore,
  StoredProject,
  QueuedTask,
  AgentHeartbeat,
  ProjectEvent,
} from "./types.js";

let stateDir = "";

// --- Init ---

export function initStorage(dir: string): void {
  stateDir = dir;
  for (const sub of ["projects", "queue", "agents"]) {
    const p = join(stateDir, sub);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
  migrateFromSingleFile();
}

function migrateFromSingleFile(): void {
  const oldPath = join(stateDir, "projects.json");
  if (!existsSync(oldPath)) return;

  try {
    const store = JSON.parse(readFileSync(oldPath, "utf-8")) as ProjectStore;
    for (const [id, project] of Object.entries(store)) {
      const dest = join(stateDir, "projects", `${id}.json`);
      if (!existsSync(dest)) {
        writeFileSync(dest, JSON.stringify(project, null, 2), "utf-8");
      }
    }
    renameSync(oldPath, `${oldPath}.migrated`);
  } catch {
    // Migration failed — leave original in place
  }
}

// --- ID Generation ---

export function generateProjectId(): string {
  return `proj_${randomBytes(4).toString("hex")}`;
}

export function generateTaskId(): string {
  return `task_${randomBytes(4).toString("hex")}`;
}

function generateEventId(): string {
  return `evt_${randomBytes(4).toString("hex")}`;
}

// --- Project CRUD (file-per-project) ---

export function getProject(projectId: string): StoredProject | null {
  const fp = join(stateDir, "projects", `${projectId}.json`);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, "utf-8")) as StoredProject;
  } catch {
    return null;
  }
}

export function saveProject(project: StoredProject): void {
  const fp = join(stateDir, "projects", `${project.projectId}.json`);
  writeFileSync(fp, JSON.stringify(project, null, 2), "utf-8");
}

export function deleteProject(projectId: string): boolean {
  const fp = join(stateDir, "projects", `${projectId}.json`);
  if (!existsSync(fp)) return false;
  unlinkSync(fp);
  // Also remove event log if exists
  const eventsPath = join(stateDir, "projects", `${projectId}.events.jsonl`);
  if (existsSync(eventsPath)) unlinkSync(eventsPath);
  return true;
}

export interface ProjectFilter {
  status?: string;
  agent?: string;
  group?: string;
}

export function listProjects(filter?: ProjectFilter): StoredProject[] {
  const dir = join(stateDir, "projects");
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  let projects: StoredProject[] = [];

  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf-8")) as StoredProject;
      projects.push(data);
    } catch {
      // Skip corrupt files
    }
  }

  if (filter?.status) {
    projects = projects.filter((p) => p.currentStatus === filter.status);
  }
  if (filter?.agent) {
    projects = projects.filter((p) => p.agent.name === filter.agent);
  }
  if (filter?.group) {
    projects = projects.filter((p) => p.project.group === filter.group);
  }

  return projects.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// --- Deprecated wrappers (backward compat during transition) ---

/** @deprecated Use getProject/saveProject/listProjects instead */
export function loadProjects(): ProjectStore {
  const all = listProjects();
  const store: ProjectStore = {};
  for (const p of all) store[p.projectId] = p;
  return store;
}

/** @deprecated Use saveProject instead */
export function saveProjects(store: ProjectStore): void {
  for (const project of Object.values(store)) {
    saveProject(project);
  }
}

// --- Queue CRUD ---

export function saveTask(task: QueuedTask): void {
  const fp = join(stateDir, "queue", `${task.taskId}.json`);
  writeFileSync(fp, JSON.stringify(task, null, 2), "utf-8");
}

export function getTask(taskId: string): QueuedTask | null {
  const fp = join(stateDir, "queue", `${taskId}.json`);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, "utf-8")) as QueuedTask;
  } catch {
    return null;
  }
}

export function listQueue(agentName?: string): QueuedTask[] {
  const dir = join(stateDir, "queue");
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  let tasks: QueuedTask[] = [];

  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf-8")) as QueuedTask;
      tasks.push(data);
    } catch {
      // Skip corrupt files
    }
  }

  if (agentName) {
    tasks = tasks.filter((t) => t.agent.name === agentName);
  }

  return tasks.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export function deleteTask(taskId: string): boolean {
  const fp = join(stateDir, "queue", `${taskId}.json`);
  if (!existsSync(fp)) return false;
  unlinkSync(fp);
  return true;
}

// --- Agent Heartbeat CRUD ---

export function saveAgentHeartbeat(hb: AgentHeartbeat): void {
  const fp = join(stateDir, "agents", `${hb.agentName}.json`);
  writeFileSync(fp, JSON.stringify(hb, null, 2), "utf-8");
}

export function getAgentHeartbeat(agentName: string): AgentHeartbeat | null {
  const fp = join(stateDir, "agents", `${agentName}.json`);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, "utf-8")) as AgentHeartbeat;
  } catch {
    return null;
  }
}

export function listAgents(): AgentHeartbeat[] {
  const dir = join(stateDir, "agents");
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const agents: AgentHeartbeat[] = [];

  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf-8")) as AgentHeartbeat;
      agents.push(data);
    } catch {
      // Skip corrupt files
    }
  }

  return agents;
}

// --- Event Log (JSONL per project) ---

export function appendEvent(projectId: string, event: Omit<ProjectEvent, "eventId">): ProjectEvent {
  const full: ProjectEvent = { ...event, eventId: generateEventId() };
  const fp = join(stateDir, "projects", `${projectId}.events.jsonl`);
  appendFileSync(fp, JSON.stringify(full) + "\n", "utf-8");
  return full;
}

export function getEventLog(projectId: string): ProjectEvent[] {
  const fp = join(stateDir, "projects", `${projectId}.events.jsonl`);
  if (!existsSync(fp)) return [];
  try {
    const lines = readFileSync(fp, "utf-8").trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as ProjectEvent);
  } catch {
    return [];
  }
}
