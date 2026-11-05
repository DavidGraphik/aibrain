import "server-only";

// Task-center reads stream one authorized conversation history at a time and
// reduce it immediately to small task DTOs. Admit one scan per process, including
// reads after PATCH. Every caller still performs its own fresh access checks;
// no history or response is cached or shared between sessions.
let tail: Promise<void> = Promise.resolve();

export function queueTaskCenterRead<T>(read: () => Promise<T>): Promise<T> {
  const result = tail.then(read);
  tail = result.then(() => undefined, () => undefined);
  return result;
}
