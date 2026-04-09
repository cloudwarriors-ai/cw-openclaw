import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
// Services
import { createHeartbeatMonitorService } from "./src/services/heartbeat-monitor.js";
import { initStorage, listProjects, listAgents, listQueue, listDocs } from "./src/storage.js";
import { agentStatusSchema, executeAgentStatus } from "./src/tools/agent-status.js";
import { docGetSchema, executeDocGet } from "./src/tools/doc-get.js";
import { docUploadSchema, executeDocUpload } from "./src/tools/doc-upload.js";
import { heartbeatSchema, executeHeartbeat } from "./src/tools/heartbeat.js";
import { projectDeleteSchema, executeProjectDelete } from "./src/tools/project-delete.js";
import { projectGetSchema, executeProjectGet } from "./src/tools/project-get.js";
import { projectListSchema, executeProjectList } from "./src/tools/project-list.js";
// Tools
import { projectUpdateSchema, executeProjectUpdate } from "./src/tools/project-update.js";
import { taskAssignSchema, executeTaskAssign } from "./src/tools/task-assign.js";
import { taskListQueueSchema, executeTaskListQueue } from "./src/tools/task-list-queue.js";
import { taskStartSchema, executeTaskStart } from "./src/tools/task-start.js";
import type { DashboardProject } from "./src/types.js";

const plugin = {
  id: "team-lead",
  name: "Team Lead",
  description:
    "Project tracking for team lead — receives status updates from remote agents, " +
    "manages task queue, monitors agent health, and provides a dashboard",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const workspace =
      (api.config as Record<string, string>).workspace ||
      process.env.OPENCLAW_WORKSPACE ||
      `${process.env.HOME}/.openclaw/workspace`;
    initStorage(`${workspace}/team-lead`);

    api.logger.info("Team Lead v2 plugin loaded — registering tools, services, and routes");

    // --- Project tools ---

    api.registerTool(() => ({
      name: "team_lead_update",
      description:
        "Receive a structured project status update from a remote agent. " +
        "Creates a new project (returns generated ID) if projectId is null, " +
        "or updates an existing project. Returns { projectId, acknowledged }.",
      parameters: projectUpdateSchema,
      execute: executeProjectUpdate,
    }));

    api.registerTool(() => ({
      name: "team_lead_get_project",
      description: "Retrieve full details, history, and event log for a tracked project by its ID.",
      parameters: projectGetSchema,
      execute: executeProjectGet,
    }));

    api.registerTool(() => ({
      name: "team_lead_list_projects",
      description:
        "List all tracked projects with agent, branch, PR, problem, and status. " +
        "Optionally filter by status or agent name. Returns both JSON and a formatted table.",
      parameters: projectListSchema,
      execute: executeProjectList,
    }));

    api.registerTool(() => ({
      name: "team_lead_delete_project",
      description: "Delete a tracked project by its ID.",
      parameters: projectDeleteSchema,
      execute: executeProjectDelete,
    }));

    // --- Task queue tools ---

    api.registerTool(() => ({
      name: "team_lead_assign_task",
      description:
        "Assign a task to an agent. Use startMode 'queued' to add to the agent's inbox, " +
        "or 'now' to create a project immediately (checks agent capacity first).",
      parameters: taskAssignSchema,
      execute: executeTaskAssign,
    }));

    api.registerTool(() => ({
      name: "team_lead_list_queue",
      description: "List all queued tasks awaiting start. Optionally filter by agent name.",
      parameters: taskListQueueSchema,
      execute: executeTaskListQueue,
    }));

    api.registerTool(() => ({
      name: "team_lead_start_task",
      description:
        "Promote a queued task to an active project. Removes from queue, creates project with status in_progress.",
      parameters: taskStartSchema,
      execute: executeTaskStart,
    }));

    // --- Agent health tools ---

    api.registerTool(() => ({
      name: "team_lead_heartbeat",
      description:
        "Receive a heartbeat from a remote agent. Reports agent health and capacity. " +
        "Agents should call this every 60 seconds.",
      parameters: heartbeatSchema,
      execute: executeHeartbeat,
    }));

    api.registerTool(() => ({
      name: "team_lead_agent_status",
      description:
        "Query agent health and capacity. Provide agentName to check one agent, " +
        "or omit to list all agents with their status.",
      parameters: agentStatusSchema,
      execute: executeAgentStatus,
    }));

    // --- Architecture docs tools ---

    api.registerTool(() => ({
      name: "team_lead_upload_doc",
      description:
        "Upload or update an architecture document for a tracked project. " +
        "Documents are keyed by title (slug). Re-uploading the same title overwrites the content.",
      parameters: docUploadSchema,
      execute: executeDocUpload,
    }));

    api.registerTool(() => ({
      name: "team_lead_get_docs",
      description:
        "Retrieve architecture docs. Provide projectId + slug for a single doc with full content, " +
        "only projectId for that project's doc list, or omit both to browse all docs across all projects.",
      parameters: docGetSchema,
      execute: executeDocGet,
    }));

    // --- Heartbeat monitor service ---

    api.registerService(createHeartbeatMonitorService());

    // --- Dashboard command ---

    api.registerCommand({
      name: "team-lead-dashboard",
      description: "Show project tracking dashboard with agent health",
      handler() {
        const projects = listProjects();
        const agents = listAgents();
        const queue = listQueue();

        const dashboard: DashboardProject[] = projects.map((p) => ({
          projectId: p.projectId,
          agent: p.agent.name,
          projectName: p.project.name,
          group: p.project.group ?? null,
          branch: p.project.branch,
          pr: p.project.pr,
          problem: p.problem,
          status: p.currentStatus,
          lastUpdate: p.updatedAt,
          ...(p.configProfile && { configProfile: p.configProfile }),
          ...(p.pullRequest && { pullRequest: p.pullRequest }),
        }));

        // Projects table
        const pHeader = "| Agent | Group | Project | Config | Branch / PR | Problem | Status |";
        const pSep = "|-------|-------|---------|--------|-------------|---------|--------|";
        const pRows = dashboard.map((d) => {
          let branchPr: string;
          if (d.pullRequest) {
            branchPr = `${d.branch} #${d.pullRequest.number} (${d.pullRequest.status})`;
          } else {
            branchPr = d.pr ? `${d.branch} ${d.pr}` : d.branch;
          }
          const grp = d.group ?? "—";
          const cfg = d.configProfile ?? "—";
          return `| ${d.agent} | ${grp} | ${d.projectName} | ${cfg} | ${branchPr} | ${d.problem} | ${d.status} |`;
        });
        const projectTable = projects.length
          ? [pHeader, pSep, ...pRows].join("\n")
          : "No tracked projects.";

        // Agents table
        const aHeader = "| Agent | Capacity | Status | Last Heartbeat |";
        const aSep = "|-------|----------|--------|----------------|";
        const now = Date.now();
        const aRows = agents.map((a) => {
          const elapsed = now - new Date(a.lastHeartbeat).getTime();
          const status = elapsed > 180_000 ? "unresponsive" : a.status;
          return `| ${a.agentName} | ${a.capacity} | ${status} | ${a.lastHeartbeat} |`;
        });
        const agentTable = agents.length
          ? [aHeader, aSep, ...aRows].join("\n")
          : "No agents registered.";

        const queueCount = queue.length;
        const openPRs = dashboard.filter((d) => d.pullRequest?.status === "open").length;
        const allDocs = listDocs();
        const docProjects = new Set(allDocs.map((d) => d.projectId)).size;

        return {
          type: "text" as const,
          body:
            `## Project Dashboard\n\n${projectTable}\n\n` +
            `## Agent Health\n\n${agentTable}\n\n` +
            `_${projects.length} project(s) tracked, ${agents.length} agent(s) registered, ${queueCount} task(s) queued, ` +
            `${openPRs} open PR(s), ${allDocs.length} doc(s) across ${docProjects} project(s)_`,
        };
      },
    });
  },
};

export default plugin;
