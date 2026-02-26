import fs from "node:fs/promises";
import path from "node:path";

import type {
  ApprovedQaRecord,
  DatasetArtifact,
  EvalItem,
  FeedbackAction,
  SlmPipelineState,
  TrainingRun,
} from "./types.js";

type PipelineStateSnapshot = {
  approvedQa: ApprovedQaRecord[];
  datasets: DatasetArtifact[];
  runs: TrainingRun[];
  evalItems: EvalItem[];
  feedbackActions: FeedbackAction[];
  idempotency: string[];
};

export type SlmPipelineStateStore = {
  getState: () => Promise<SlmPipelineState>;
  saveState: (state: SlmPipelineState) => Promise<void>;
};

export function createInitialSlmPipelineState(): SlmPipelineState {
  return {
    approvedQa: [],
    datasets: new Map(),
    runs: new Map(),
    evalItems: new Map(),
    feedbackActions: [],
    idempotency: new Set(),
  };
}

export class InMemorySlmPipelineStateStore implements SlmPipelineStateStore {
  private readonly state = createInitialSlmPipelineState();

  async getState(): Promise<SlmPipelineState> {
    return this.state;
  }

  async saveState(_state: SlmPipelineState): Promise<void> {}
}

export class JsonFileSlmPipelineStateStore implements SlmPipelineStateStore {
  private cached: SlmPipelineState | null = null;
  private loadPromise: Promise<SlmPipelineState> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async getState(): Promise<SlmPipelineState> {
    if (this.cached) {
      return this.cached;
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }
    this.loadPromise = this.loadState();
    const state = await this.loadPromise;
    this.cached = state;
    this.loadPromise = null;
    return state;
  }

  async saveState(state: SlmPipelineState): Promise<void> {
    this.cached = state;
    const snapshot = toSnapshot(state);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(snapshot, null, 2), "utf8");
    });
    return this.writeQueue;
  }

  private async loadState(): Promise<SlmPipelineState> {
    let raw = "";
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch {
      return createInitialSlmPipelineState();
    }
    if (!raw.trim()) {
      return createInitialSlmPipelineState();
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return createInitialSlmPipelineState();
      }
      return fromSnapshot(parsed as Partial<PipelineStateSnapshot>);
    } catch {
      return createInitialSlmPipelineState();
    }
  }
}

export function resolveDefaultSlmPipelineStatePath(stateDir: string): string {
  return path.join(stateDir, "slm-pipeline-state.json");
}

function toSnapshot(state: SlmPipelineState): PipelineStateSnapshot {
  return {
    approvedQa: state.approvedQa,
    datasets: [...state.datasets.values()],
    runs: [...state.runs.values()],
    evalItems: [...state.evalItems.values()],
    feedbackActions: state.feedbackActions,
    idempotency: [...state.idempotency.values()],
  };
}

function fromSnapshot(snapshot: Partial<PipelineStateSnapshot>): SlmPipelineState {
  const state = createInitialSlmPipelineState();
  for (const record of snapshot.approvedQa ?? []) {
    state.approvedQa.push(record);
  }
  for (const dataset of snapshot.datasets ?? []) {
    state.datasets.set(dataset.dataset_id, dataset);
  }
  for (const run of snapshot.runs ?? []) {
    state.runs.set(run.run_id, run);
  }
  for (const item of snapshot.evalItems ?? []) {
    state.evalItems.set(item.item_id, item);
  }
  for (const action of snapshot.feedbackActions ?? []) {
    state.feedbackActions.push(action);
  }
  for (const key of snapshot.idempotency ?? []) {
    state.idempotency.add(key);
  }
  return state;
}
