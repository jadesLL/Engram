export type AssistantRunStatus =
  | 'queued'
  | 'running'
  | 'executing'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type AssistantMessageRole = 'user' | 'assistant' | 'tool';
export type ToolRisk = 'read' | 'reversible' | 'high' | 'restricted';
export type ToolCallStatus =
  | 'running'
  | 'proposed'
  | 'approved'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'undone';

export interface AssistantPageContext {
  id: string;
  title: string;
  path: string;
  updatedAt?: string;
}

export interface AssistantFileContext {
  path: string;
  name?: string;
}

export interface AssistantContext {
  route?: string;
  currentPage?: AssistantPageContext;
  currentFile?: AssistantFileContext;
  selection?: string;
  preset?: 'continue' | 'polish' | 'expand' | 'summarize' | 'translate';
  presetText?: string;
}

export interface AssistantSession {
  id: string;
  title: string;
  summary: string;
  archived: boolean;
  /** chat/question 历史世代的锚点消息 id：世代内窗口头部冻结，保证 provider 前缀缓存命中 */
  chatAnchorId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantMessage {
  id: string;
  sessionId: string;
  runId?: string;
  role: AssistantMessageRole;
  content: string;
  metadata: Record<string, any>;
  createdAt: string;
}

export interface AssistantRun {
  id: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId?: string;
  status: AssistantRunStatus;
  context: AssistantContext;
  stepCount: number;
  cancelRequested: boolean;
  error?: string;
  ingestedPath?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AssistantToolCall {
  id: string;
  runId: string;
  name: string;
  arguments: Record<string, any>;
  risk: ToolRisk;
  status: ToolCallStatus;
  preview: ToolPreview;
  result: Record<string, any>;
  undo: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantArtifact {
  id: string;
  runId: string;
  toolCallId?: string;
  kind: string;
  contentHash: string;
  content: string;
  createdAt: string;
}

export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
}

export interface ToolPreview {
  title?: string;
  summary?: string;
  target?: string;
  details?: Record<string, any>;
  diff?: DiffLine[];
  precondition?: Record<string, any>;
  secondConfirmation?: boolean;
}

export interface AssistantSnapshot {
  session: AssistantSession;
  messages: AssistantMessage[];
  runs: AssistantRun[];
  toolCalls: AssistantToolCall[];
}

export interface ApprovalDecision {
  toolCallId: string;
  approved: boolean;
  confirmHighImpact?: boolean;
}

export interface AssistantSource {
  id: string;
  refType: 'page' | 'file';
  refId: string;
  title: string;
  path: string;
  heading?: string;
  snippet: string;
  evidence: string[];
  updatedAt?: string;
}
