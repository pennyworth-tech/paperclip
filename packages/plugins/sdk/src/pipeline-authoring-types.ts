export interface PluginPipelineSummary {
  id: string; companyId: string; key: string; name: string; projectId: string | null;
  stages: Array<{ id: string; key: string; name: string; kind: string; position: number; config: Record<string, unknown> }>;
}
export interface PluginPipelineCaseSummary {
  id: string; companyId: string; pipelineId: string; title: string; caseKey: string;
  stageKey: string; stageKind: string; version: number; fields: Record<string, unknown>;
}
export interface PluginCaseWorkBinding {
  id: string; companyId: string; caseId: string; issueId: string; turn: number;
  role: string; agentId: string | null; revisionId: string | null;
  sourceRevisionId?: string | null; sourceContentDigest?: string | null;
  /** A pending source publication parks this same task and prevents dispatch/approval. */
  sourceWriteId?: string | null;
}
export interface PluginCaseWorkTurn extends Omit<PluginCaseWorkBinding, "id"> {
  id: string; requestKey: string; priorResultId: string | null;
}
export interface PluginCaseWorkResult {
  id: string; companyId: string; caseId: string; turn: number; role: string;
  agentId: string; runId: string; revisionId: string; contentDigest: string; result: Record<string, unknown>;
}
export interface PluginCaseWorkExecution {
  state: "not_requested" | "pending" | "active" | "terminal" | "unknown";
  requestIds: string[]; runIds: string[]; runs: Array<{ id: string; status: string }>;
}
export interface PluginCaseWorkHandoff {
  expectedTurn: number; expectedAgentId: string | null; requestKey: string;
  /** Optional source/case preconditions for a deliberately scoped preparation turn. */
  expectedVersion?: number; expectedSourceRevisionId?: string | null;
  role: "author" | "editor" | "reviewer" | "human" | "waiting"; agentId: string | null;
  revisionId: string | null; priorResultId?: string; reason: string;
  /** Retry/park an ended turn that produced no result; the host verifies native run receipts. */
  recoveryRunId?: string;
}
export interface PluginPipelineAuthoringClient {
  /** Publish a new validated source identity; only the configured producer can reopen review. */
  publishRevision(caseId: string, input: { expectedVersion: number; baseRevisionId: string | null;
    requestKey: string; revisionId: string; contentDigest: string; reason: string; sourceWriteId?: string }, companyId: string): Promise<{ caseId: string; version: number; eventId: string }>;
  list(companyId: string): Promise<PluginPipelineSummary[]>;
  listCases(pipelineId: string, companyId: string, page?: { limit?: number; offset?: number }): Promise<PluginPipelineCaseSummary[]>;
  createCase(input: { pipelineId: string; caseKey: string; title: string; summary?: string;
    fields?: Record<string, unknown>; workspaceRef?: Record<string, unknown> }, companyId: string): Promise<{ id: string; created: boolean }>;
  patchCase(caseId: string, input: { expectedVersion: number; title?: string; summary?: string;
    fields?: Record<string, unknown>; workspaceRef?: Record<string, unknown> }, companyId: string): Promise<{ id: string; version: number }>;
  linkIssue(caseId: string, input: { issueId: string; role: "origin" | "conversation" | "work" }, companyId: string): Promise<{ id: string }>;
  transitionCase(caseId: string, input: { expectedVersion: number; toStageKey: string; reason?: string }, companyId: string): Promise<{ id: string; version: number }>;
  listEvents(caseId: string, companyId: string, page?: { limit?: number; offset?: number }): Promise<{
    items: Array<{ id: string; type: string; actorType: string; actorAgentId: string | null; actorUserId: string | null; payload: Record<string, unknown> }>;
    pagination: { nextOffset: number | null; hasMore: boolean } }>;
  getWork(caseId: string, companyId: string): Promise<(PluginCaseWorkBinding & { turns: PluginCaseWorkTurn[]; results: PluginCaseWorkResult[]; execution?: PluginCaseWorkExecution }) | null>;
  bindWork(caseId: string, issueId: string, companyId: string): Promise<PluginCaseWorkBinding>;
  handoffWork(caseId: string, input: PluginCaseWorkHandoff, companyId: string): Promise<PluginCaseWorkTurn>;
  recordWorkResult(caseId: string, input: { expectedTurn: number; agentId: string; runId: string;
    revisionId: string; contentDigest: string; result: Record<string, unknown> }, companyId: string): Promise<PluginCaseWorkResult>;
}
