/** Share only ongoing reads inside the exact actor/project boundary. No result cache. */
export class ServerBrowseInflight {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly maximum = 32) {}

  run<T>(key: string, read: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    if (this.pending.size >= this.maximum) return Promise.reject(new Error("SERVER_BROWSE_QUEUE_FULL"));
    const operation = Promise.resolve().then(read).finally(() => {
      if (this.pending.get(key) === operation) this.pending.delete(key);
    });
    this.pending.set(key, operation);
    return operation;
  }
}
