import { createHash, randomUUID } from "node:crypto";

import type { ApprovedQaRecord, DatasetArtifact, DatasetExample } from "./types.js";

export class DatasetBuilderService {
  build(params: {
    tenantId: string;
    splitSeed: number;
    approvedQa: ApprovedQaRecord[];
    now?: () => Date;
  }): DatasetArtifact {
    const now = (params.now ?? (() => new Date()))().toISOString();
    const examples = params.approvedQa.map((record) => this.toExample(record));
    const train: DatasetExample[] = [];
    const evalSet: DatasetExample[] = [];

    for (const example of examples) {
      const bucket = stableBucket(example.example_id, params.splitSeed);
      if (bucket < 8) {
        train.push(example);
      } else {
        evalSet.push(example);
      }
    }

    const manifestHash = createHash("sha256")
      .update(
        JSON.stringify({
          tenant_id: params.tenantId,
          split_seed: params.splitSeed,
          example_ids: examples.map((example) => example.example_id).toSorted(),
        }),
      )
      .digest("hex");

    return {
      dataset_id: randomUUID(),
      tenant_id: params.tenantId,
      split_seed: params.splitSeed,
      manifest_hash: manifestHash,
      train,
      eval: evalSet,
      created_at: now,
    };
  }

  private toExample(record: ApprovedQaRecord): DatasetExample {
    return {
      example_id: record.example_id,
      tenant_id: record.tenant_id,
      input: record.question,
      target: record.answer,
      citations: record.citations,
      source_ids: record.source_message_ids,
    };
  }
}

function stableBucket(exampleId: string, seed: number): number {
  const digest = createHash("sha256").update(`${exampleId}:${seed}`).digest("hex");
  return Number.parseInt(digest.slice(0, 2), 16) % 10;
}
