import type { ExperimentQueue, ExperimentMessage } from "./queue.js";
import type { R2Binding } from "./r2-store.js";

interface QueueMessage<T> {
  readonly id: string;
  readonly body: T;
  ack(): void;
}

interface MessageBatch<T> {
  readonly messages: QueueMessage<T>[];
}

export interface ResearchWorkerEnv {
  RESEARCH_QUEUE: ExperimentQueue;
  RESEARCH_BUCKET: R2Binding;
  DIFFCI_RESEARCH_ENABLED: string;
}

export default {
  async fetch(_request: Request, env: ResearchWorkerEnv): Promise<Response> {
    if (env.DIFFCI_RESEARCH_ENABLED !== "true") {
      return new Response("DiffCI research platform disabled", { status: 503 });
    }
    return new Response("DiffCI research platform worker", { status: 200 });
  },
  async queue(batch: MessageBatch<ExperimentMessage>, _env: ResearchWorkerEnv): Promise<void> {
    for (const message of batch.messages) {
      console.log("Research queue message", message.body);
      message.ack();
    }
  },
};
