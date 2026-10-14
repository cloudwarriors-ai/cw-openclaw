import { AsyncLocalStorage } from "node:async_hooks";

/** Host-only provenance; never read a timestamp from caller or tool arguments. */
const lifetimes = new AsyncLocalStorage<Readonly<{ runId: string; startedAt: number }>>();

/** Each logical invocation gets a fresh scope, including reused IDs and siblings. */
export function withRequesterRunLifetime<T>(runId: string, run: () => T): T {
  return lifetimes.run(Object.freeze({ runId, startedAt: performance.now() }), run);
}

/** Different nested/subagent run IDs cannot borrow their parent's provenance. */
export function requesterRunStartedAt(runId: string): number | undefined {
  const scope = lifetimes.getStore();
  return scope && scope.runId === runId ? scope.startedAt : undefined;
}
