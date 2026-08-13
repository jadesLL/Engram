import type {
  ApprovalDecision,
  AssistantContext,
  AssistantRun,
} from './types.js';

export interface AssistantRuntime {
  startRun(
    sessionId: string,
    message: string,
    context?: AssistantContext,
  ): AssistantRun;
  decideRun(runId: string, decisions: ApprovalDecision[]): Promise<void>;
  cancelRun(runId: string): AssistantRun;
  retryRun(runId: string): AssistantRun;
  ingestRun(runId: string): Promise<{ path: string; id: string }>;
  undoToolCall(callId: string): Promise<void>;
  snapshotForRun(runId: string): unknown;
}
