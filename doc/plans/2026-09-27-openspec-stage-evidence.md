# Revision-bound pipeline stage evidence

Protected pipeline stages bind decisions to immutable document revisions and plugin-produced evidence. This contract allows consumers to verify exactly what was approved.

## Host contract

- A stage can declare `evidencePolicy` with an evidence kind, an installed plugin
  key, required case document keys, and an optional prerequisite review stage.
- `ctx.pipelines.publishEvidence` requires `pipeline.cases.evidence.write`. The
  host derives the producer from the installed plugin and enforces the invocation
  company. The strict payload contains an expected case version, retry key,
  opaque source revision/digest, document revision pins, prerequisite event IDs,
  readiness, and bounded domain details.
- Minting locks the case, verifies pins, appends an immutable receipt, advances
  its case version, and updates the host-owned `stageEvidenceId`. Replaying the
  same request returns the original receipt; changing its content returns a
  conflict. A receipt is not approval.
- Native and plugin review calls pass the observed `evidenceId` and case version.
  The shared transition service verifies both under the case lock and snapshots
  the receipt into the decision event. An inline content edit cannot approve its
  previous evidence in the same transaction.
- Protected review exits require an explicit review decision. A destination can
  declare `requireApprovedEntryFromStageKey`; forced moves, suggestions, and new
  case ingestion cannot skip that prerequisite. Request-changes and cancellation
  remain available to the authorized stage actor when evidence is incomplete.
- A later human stage requires the latest technical decision for the same source
  digest, source revision, and document pins. An older approval cannot override
  a newer adverse verdict. Existing role authorization remains authoritative.
- Case content/workspace changes and pinned document changes clear readiness.
  Shared issue document writes and restores participate in the same case lock.
  Blocking annotations on shared documents invalidate synchronously; ordinary
  notes do not. Resolving a blocker records a disposition and actor. Removing its
  linked issue comment does not silently resolve an open blocker.

No field in the caller-writable case JSON can replace the protected pointer.
Existing pipelines without evidence policies retain their review behavior.

## Verification so far

Real embedded PostgreSQL checks cover nine scenarios: immutable replay and
decision snapshots; company/producer/document boundaries; direct, forced,
suggested, and ingestion bypass attempts; document and case-field invalidation;
native blocking feedback and disposition; concurrent writes; exact technical
review at the human gate; inline-edit rollback and incomplete evidence; and the
capability-checked plugin host port.

The first regression run passed 75 tests across evidence, pipeline service,
pipeline routes, and native annotations. The expanded evidence/bridge run passed
84 tests across evidence, real plugin orchestration, host handlers, and worker
RPC. These runs overlap. Shared and SDK package typechecks and direct server/UI
TypeScript checks passed.

The server's full typecheck wrapper initially stopped because `cargo` was absent;
the required Rust toolchain is being installed before the full release checks.
The UI token gate reports nine pre-existing color literals in
`ui/src/components/onboarding/PillGuy.tsx`. This change adds no visual tokens.

## Remaining delivery work

Complete the general case host ports, guarded publication/reopen operation,
pipeline-native source annotation integration, and durable shared-task handoffs.
Build the Studio plugin with revision storage, source editing, dossier views,
agent contracts, controlled intake, and delivery handoff. Run the complete
isolated pilot and recovery matrix before live provisioning. Do not activate
the production evidence policy from these partial checks alone.

## Revision-bound work and source editing

Pipeline preparation uses one durable work record per case. Turns identify the
current agent, role, source revision and plugin producer. Queued claims and issue
checkouts must match that turn. Completed work keeps an immutable result receipt;
a handoff does not make an old queued continuation current again.

Company-scoped workspace APIs inspect and edit repository sources through the
execution target. A preview runs in an isolated snapshot and verifies the source
revision, bounded paths and content hashes. Publication records a durable candidate
before pushing without force. Recovery reconciles that same candidate rather than
creating another commit after a lost response.

A source writer reserves the case and workspace before changing Git. Pending
publication prevents new execution, handoffs, evidence approval, workspace
rebinding and cleanup. Releasing a reservation requires a matching publication
receipt or proof that no push was attempted. An expired attempt lease alone does
not release ownership.

Native case annotations remain company-scoped and revision-bound. Blocking
feedback invalidates stage evidence; resolving it requires a disposition. Rendered
review artifacts use a renderer selected by exact digest. The private consumer
owns its workflow configuration and delivery policy.

Migration generation follows the selected upstream journal. Existing downstream
migration adoption, actual database concurrency, provider execution and complete
application qualification are required before rollout; local source reconstruction
and schema snapshot checks do not establish those properties.
