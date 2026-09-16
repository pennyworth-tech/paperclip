import type { FeedbackDataSharingPreference } from "./feedback.js";

export const DAILY_RETENTION_PRESETS = [3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;
export const DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24;
export const MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 1;
export const MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24 * 30;
export const DEFAULT_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_OWNER_PER_SWEEP = 1;
export const MIN_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_OWNER_PER_SWEEP = 1;
export const MAX_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_OWNER_PER_SWEEP = 50;

export interface BackupRetentionPolicy {
  dailyDays: (typeof DAILY_RETENTION_PRESETS)[number];
  weeklyWeeks: (typeof WEEKLY_RETENTION_PRESETS)[number];
  monthlyMonths: (typeof MONTHLY_RETENTION_PRESETS)[number];
}

export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  dailyDays: 7,
  weeklyWeeks: 4,
  monthlyMonths: 1,
};

/**
 * Instance-wide execution policy.
 *
 * - `"any"` (default / absent): unrestricted — any environment driver (local,
 *   ssh, sandbox) may run agents. Preserves single-tenant / local-trusted
 *   behavior.
 * - `"kubernetes"`: force ALL agent execution onto the Kubernetes
 *   sandbox-provider environment and REFUSE local/in-process execution. Used by
 *   shared cloud (cloud_tenant) instances so untrusted tenant agents can never
 *   run in the server process or on an unsandboxed local/ssh adapter.
 */
export type InstanceExecutionMode = "kubernetes" | "any";

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetention: BackupRetentionPolicy;
  /**
   * Execution policy. Absent/`"any"` = unrestricted; `"kubernetes"` forces the
   * Kubernetes sandbox provider and denies local/ssh execution.
   */
  executionMode?: InstanceExecutionMode;
}

export interface InstanceExperimentalSettings {
  enableEnvironments: boolean;
  /**
   * Exposes the experimental Paperclip Runner adapter for new selections.
   * Existing native runs ignore later flag changes so they remain recoverable.
   */
  enableNativeRunner: boolean;
  /**
   * Hide the local environment and run all agents in the platform-managed
   * sandbox environment. Run selection refuses local while this is on.
   */
  enableManagedSandboxOnly: boolean;
  enableIsolatedWorkspaces: boolean;
  enableStreamlinedLeftNavigation: boolean;
  enableApps: boolean;
  enablePipelines: boolean;
  enableCases: boolean;
  enableConferenceRoomChat: boolean;
  enableClassicTaskInterface: boolean;
  enableTaskWatchdogs: boolean;
  enableIssuePlanDecompositions: boolean;
  /**
   * When enabled, an issue whose title identifies it as a PR review issue
   * (e.g. "Review PR #N (<repo>) — …") cannot transition to `done`
   * unless a comment authored by the assigned reviewer has a first line
   * matching the verdict opener
   * `<APPROVE|REQUEST CHANGES|NEEDS INFO> — PR #<n> at head <40-hex-sha>`.
   * Shape-only; freshness (the sha being the pull request's current head)
   * is checked separately, not here. Default `false`; opt-in because it
   * changes when an issue may be closed.
   */
  requireReviewIssueVerdictOpener: boolean;
  enableExperimentalFileViewer: boolean;
  enableExternalObjects: boolean;
  enableSmokeLab: boolean;
  enableBuiltInAgents: boolean;
  enableBetaSkills: boolean;
  enableSummaries: boolean;
  enableStatusCards: boolean;
  enableDecisions: boolean;
  enableGoalsSidebarLink: boolean;
  enableServerInfoDebugView: boolean;
  /**
   * Instructs agents to write user-interaction content (confirmations,
   * questions, suggested tasks, checkbox prompts) in ASD-STE100 Simplified
   * Technical English with brief decision context. Prompt-side only; no
   * behavior change outside interaction wording.
   */
  enableSimplifiedEnglishInteractions: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableIssueGraphLivenessAutoRecovery: boolean;
  enableWorkspaceBranchReconcileForward: boolean;
  enableWorkspaceDirtyQuarantineRepair: boolean;
  /**
   * On cloud-managed instances, grant the stack owner instance-admin access
   * to their own dedicated instance. Elevation is computed per request at the
   * trusted-header auth boundary (owner stack role + this flag); no
   * `instance_user_roles` row is ever written. Inert on self-hosted
   * instances, which have no trusted cloud tenant path.
   */
  enableOwnerInstanceAdmin: boolean;
  /**
   * Kill switch for the sandbox duplex command-stream bridge. Default off. The
   * host reads this per run before it selects the callback bridge transport.
   * Off forces the file bridge for every run with no manifest change and no
   * redeploy.
   */
  enableSandboxDuplexBridge: boolean;
  /**
   * Worktree preview instances (`PAPERCLIP_IN_WORKTREE=true`) suppress the
   * heartbeat run engine by default so previews never self-execute tasks. When
   * this is enabled the worktree-instance scheduling suppression is lifted so
   * runs actually execute inside the preview. Ignored outside a worktree.
   */
  enableWorktreeRunExecution: boolean;
  /**
   * Server-managed cutoff recorded when worktree run execution is enabled in
   * this instance. Client PATCH payloads must not control this value.
   */
  worktreeRunExecutionActivatedAt: string | null;
  /**
   * Server-managed instance id captured with the cutoff so copied settings rows
   * from another instance fail closed.
   */
  worktreeRunExecutionActivationInstanceId: string | null;
  /**
   * Productivity-review measurement gate. When false (default), the
   * `long_active_duration` detector measures wall-clock elapsed since the
   * active episode started, exactly as upstream. When true, it measures the
   * union of the assignee's run-execution intervals clipped to the episode,
   * so dispatch-queue wait and time spent waiting on other agents no longer
   * read as assignee execution.
   */
  enableProductivityReviewActiveExecutionDuration: boolean;
  /**
   * Productivity-review burst cap gate. When false (default), a sweep may
   * create any number of reviews, exactly as upstream. When true, each sweep
   * creates at most `productivityReviewMaxCreationsPerOwnerPerSweep` reviews
   * resolving to any one owner agent; excess candidates defer to the next
   * sweep with nothing written.
   */
  enableProductivityReviewOwnerBurstCap: boolean;
  /**
   * Per-owner review creation ceiling applied only while
   * `enableProductivityReviewOwnerBurstCap` is true.
   */
  productivityReviewMaxCreationsPerOwnerPerSweep: number;
  /**
   * Server-managed operator drain. While true, every runtime
   * instance sharing this database holds run scheduling (dispatch, queued-run
   * resume, the orphan reaper) so a deploy can drain running work before a new
   * revision stages. Written only by the instance drain routes; client PATCH
   * payloads must not control this value.
   */
  operatorDrainActive: boolean;
  /**
   * When the operator drain was last armed, so a drain left set by a failed
   * deploy is visible and ageable. Null when not draining.
   */
  operatorDrainStartedAt: string | null;
  issueGraphLivenessAutoRecoveryLookbackHours: number;
}

/**
 * Boolean feature-flag keys of the experimental settings — the only keys a
 * cloud managed-config overlay may target. Server-managed bookkeeping fields
 * (activation cutoffs, lookback hours) are excluded by construction, and so
 * is `operatorDrainActive`: it is operational state owned by the instance
 * drain routes, never a configurable feature.
 */
export type ManagedExperimentalFeatureKey = Exclude<
  {
    [K in keyof InstanceExperimentalSettings]-?: InstanceExperimentalSettings[K] extends boolean
      ? K
      : never;
  }[keyof InstanceExperimentalSettings],
  "operatorDrainActive"
>;

export const PAPERCLIP_CLOUD_MANAGED_BY = "paperclip-cloud" as const;

/** Per-key metadata attached to settings responses for cloud-overlaid keys. */
export interface ManagedSettingMetadata {
  managed: true;
  managedBy: typeof PAPERCLIP_CLOUD_MANAGED_BY;
}

/**
 * Experimental settings as returned by the settings API. On cloud-managed
 * instances (`PAPERCLIP_MANAGED_CONFIG` present) `managedKeys` lists every key
 * whose value is overlaid by the harness; self-hosted responses omit it.
 */
export interface InstanceExperimentalSettingsWithManaged extends InstanceExperimentalSettings {
  managedKeys?: Partial<Record<ManagedExperimentalFeatureKey, ManagedSettingMetadata>>;
}

export interface InstanceSettings {
  id: string;
  defaultEnvironmentId: string | null;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettingsWithManaged;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueGraphLivenessAutoRecoveryPreviewItem {
  issueId: string;
  identifier: string | null;
  title: string;
  state: string;
  severity: string;
  reason: string;
  recoveryIssueId: string;
  recoveryIdentifier: string | null;
  recoveryTitle: string | null;
  recommendedOwnerAgentId: string | null;
  incidentKey: string;
  latestDependencyUpdatedAt: string;
  dependencyPath: Array<{
    issueId: string;
    identifier: string | null;
    title: string;
    status: string;
  }>;
}

export interface IssueGraphLivenessAutoRecoveryPreview {
  lookbackHours: number;
  cutoff: string;
  generatedAt: string;
  findings: number;
  recoverableFindings: number;
  skippedOutsideLookback: number;
  items: IssueGraphLivenessAutoRecoveryPreviewItem[];
}
