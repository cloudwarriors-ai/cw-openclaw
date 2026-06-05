import {
  listAgents,
  saveAgentHeartbeat,
  getProject,
  saveProject,
  appendEvent,
} from "../storage.js";

const UNRESPONSIVE_THRESHOLD_MS = 180_000; // 3 minutes
const CHECK_INTERVAL_MS = 60_000; // 1 minute

export function createHeartbeatMonitorService() {
  let interval: ReturnType<typeof setInterval> | null = null;

  return {
    id: "team-lead-heartbeat-monitor",

    async start(ctx: { logger: { warn: (msg: string) => void; info: (msg: string) => void } }) {
      ctx.logger.info("Heartbeat monitor started (check every 60s, threshold 180s)");

      const tick = () => {
        const agents = listAgents();
        const now = Date.now();

        for (const agent of agents) {
          const elapsed = now - new Date(agent.lastHeartbeat).getTime();

          if (elapsed > UNRESPONSIVE_THRESHOLD_MS && agent.status === "active") {
            agent.status = "unresponsive";
            saveAgentHeartbeat(agent);

            ctx.logger.warn(
              `Agent ${agent.agentName} marked unresponsive (no heartbeat for ${Math.round(elapsed / 1000)}s)`,
            );

            // Flag their active projects as blocked
            for (const pid of agent.activeProjects) {
              const project = getProject(pid);
              if (project && project.currentStatus === "in_progress") {
                project.currentStatus = "blocked";
                project.updatedAt = new Date().toISOString();
                project.history.push({
                  timestamp: project.updatedAt,
                  status: "blocked",
                  summary: `Agent ${agent.agentName} unresponsive`,
                  details: `No heartbeat for ${Math.round(elapsed / 1000)}s — project flagged as blocked`,
                });
                saveProject(project);

                appendEvent(pid, {
                  projectId: pid,
                  timestamp: project.updatedAt,
                  type: "status_changed",
                  actor: "heartbeat-monitor",
                  data: {
                    prevStatus: "in_progress",
                    status: "blocked",
                    reason: "agent_unresponsive",
                    agent: agent.agentName,
                  },
                });
              }
            }
          }
        }
      };

      // Run first check after a short delay, then every interval
      interval = setInterval(() => {
        try {
          tick();
        } catch {
          // Best effort — don't crash the gateway
        }
      }, CHECK_INTERVAL_MS);
      interval.unref?.();
    },

    async stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
