export interface ExperimentMessage {
  experimentId: string;
  repository: string;
  owner: string;
  name: string;
  headSha?: string;
  baseSha?: string;
  logicalDeltaKey?: string;
  retryCount: number;
}

export interface ExperimentQueue {
  send(message: ExperimentMessage): Promise<void>;
  receive(batchSize: number): Promise<ExperimentMessage[]>;
  ack(message: ExperimentMessage): Promise<void>;
  retry(message: ExperimentMessage): Promise<void>;
}

export class InMemoryExperimentQueue implements ExperimentQueue {
  private readonly messages: ExperimentMessage[] = [];

  async send(message: ExperimentMessage): Promise<void> {
    this.messages.push(message);
  }

  async receive(batchSize: number): Promise<ExperimentMessage[]> {
    return this.messages.splice(0, batchSize);
  }

  async ack(): Promise<void> {}

  async retry(message: ExperimentMessage): Promise<void> {
    this.messages.push({ ...message, retryCount: message.retryCount + 1 });
  }
}
