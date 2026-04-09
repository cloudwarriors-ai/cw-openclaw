// Project Update Protocol — types for agent-to-lead project tracking

export interface AgentInfo {
  name: string;
  machine: string;
}

export interface ProjectInfo {
  name: string;
  repo: string;
  branch: string;
  pr: string | null;
  group?: string;
}

export type ProjectStatus =
  | "queued"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "needs_review"
  | "completed"
  | "cancelled";

export type TaskStartMode = "now" | "queued";

export type AgentCapacity = "idle" | "busy" | "at_capacity";

export interface ProjectUpdatePayload {
  type: "project_update";
  projectId: string | null;
  agent: AgentInfo;
  project: ProjectInfo;
  update: {
    status: ProjectStatus;
    summary: string;
    problem: string;
    details: string;
  };
  timestamp: string;
  configProfile?: string;
  pullRequest?: Omit<PullRequestInfo, "updatedAt">;
}

export interface HistoryEntry {
  timestamp: string;
  status: ProjectStatus;
  summary: string;
  details: string;
}

export interface PullRequestInfo {
  url: string;
  number: number;
  status: "open" | "merged" | "closed";
  checksStatus?: "pending" | "passing" | "failing" | null;
  title?: string;
  updatedAt: string;
}

export interface StoredProject {
  projectId: string;
  agent: AgentInfo;
  project: ProjectInfo;
  currentStatus: ProjectStatus;
  currentSummary: string;
  problem: string;
  history: HistoryEntry[];
  createdAt: string;
  updatedAt: string;
  configProfile?: string;
  pullRequest?: PullRequestInfo;
}

export interface ProjectStore {
  [projectId: string]: StoredProject;
}

export interface DashboardProject {
  projectId: string;
  agent: string;
  projectName: string;
  group: string | null;
  branch: string;
  pr: string | null;
  problem: string;
  status: ProjectStatus;
  lastUpdate: string;
  configProfile?: string;
  pullRequest?: PullRequestInfo;
}

// --- v2: Task Queue ---

export interface QueuedTask {
  taskId: string;
  projectId: string | null;
  agent: AgentInfo;
  project: ProjectInfo;
  assignment: {
    summary: string;
    problem: string;
    details: string;
  };
  startMode: TaskStartMode;
  createdAt: string;
  assignedBy: string;
  configProfile?: string;
}

// --- v2: Heartbeat / Agent Health ---

export interface AgentHeartbeat {
  agentName: string;
  machine: string;
  capacity: AgentCapacity;
  lastHeartbeat: string;
  status: "active" | "unresponsive";
  activeProjects: string[];
}

// --- v2: Event-Sourced History ---

export type ProjectEventType =
  | "created"
  | "status_changed"
  | "updated"
  | "config_changed"
  | "deleted"
  | "pr_updated"
  | "doc_added"
  | "doc_updated";

export interface ArchitectureDoc {
  docId: string;
  projectId: string;
  slug: string;
  title: string;
  content: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectEvent {
  eventId: string;
  projectId: string;
  timestamp: string;
  type: ProjectEventType;
  actor: string;
  data: Record<string, unknown>;
}
