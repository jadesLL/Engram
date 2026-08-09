type AssistantEventListener = (event: string, data: unknown) => void;

const listeners = new Map<string, Set<AssistantEventListener>>();

export function publishAssistantEvent(runId: string, event: string, data: unknown): void {
  for (const listener of listeners.get(runId) || []) listener(event, data);
}

export function subscribeAssistantEvents(
  runId: string,
  listener: AssistantEventListener
): () => void {
  if (!listeners.has(runId)) listeners.set(runId, new Set());
  listeners.get(runId)!.add(listener);
  return () => {
    const runListeners = listeners.get(runId);
    runListeners?.delete(listener);
    if (!runListeners?.size) listeners.delete(runId);
  };
}
