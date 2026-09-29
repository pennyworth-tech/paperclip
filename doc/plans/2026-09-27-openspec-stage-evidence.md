# OpenSpec Studio host foundation

The Studio rollout uses one company pipeline and one preparation issue per case.
The Author, Briefing Editor, and Reviewer take successive turns on that issue.
This host change supplies revision-bound decision evidence, durable task turns,
source inspection/publication ports, and native case feedback. The complete
agent workflow and custom plugin rollout remain in progress.

## Draft source inspection checkpoint (2026-09-28)

Latest source-inspection checkpoint: the host can now inspect incomplete changes
and the standard `spec-driven` schema. It obtains output patterns and dependencies
from the installed CLI, records validation diagnostics even when validation fails,
and distinguishes successful source inspection from review readiness. An absent,
stale, or invalid required deck makes the revision a draft. Transport, Git identity,
dirty-worktree, symlink, encoding, and size failures still reject inspection.
Factory changes continue to require a verified deck; standard changes use their
own artifact graph. A copied workspace retains the change creation boundary so
newer unrelated factory-schema commits cannot truncate its source history.

The companion plugin publishes/project drafts as immutable source snapshots,
renders Markdown counts, dependencies, missing outputs and diagnostics without
executing invalid HTML, and permits feedback on projected draft documents.
Ready Author results, Editor/Reviewer handoffs and human approval still require a
complete validated revision. Direct edit previews continue to require a complete
factory deck; draft/standard-schema editing remains unfinished.

Current validation: **44 real Git/CLI host checks** and **108 plugin checks** pass;
SDK build, server/plugin typecheck and plugin build pass. Both actual OS/Core
decks pass the new inspection and plugin projection with unchanged digests. Their
remote query is simulated; copied-workspace tests use the actual adapter transfer
scripts through a simulated provider command runner. Logs are
`/private/tmp/openspec-draft-host-regressions.log`,
`/private/tmp/openspec-draft-plugin-tests-final.log`, and
`/private/tmp/openspec-draft-real-inspection.json`. No new native database,
browser, deployed-provider, or full-host-gate acceptance is claimed. SSH DNS and
live Paperclip CLI health probes still fail in this session. The historical
checkpoints below describe earlier boundaries, not the latest inspection support.

## Source edit executor checkpoint (2026-09-28)

The internal executor previews bounded Markdown edits in an isolated Git
snapshot, validates them with the installed OpenSpec CLI, and runs only the
reviewed renderer identified by its exact SHA-256. Preview preserves canonical
files, branch, index, and remote. Apply creates a source commit and a generated
deck commit, preserving the remaining repository tree. It requires the observed
branch, SSH origin, base commit, and individual file hashes.

A host-owned pre-push hook checks the server's advertised base SHA, followed by
Git's ordinary receive-pack comparison. Publication uses no force-push option.
The operation journal records the candidate before pushing, so a lost response
resumes the same commit. It checks for concurrent local edits before pushing and
again before synchronization, preserves foreign index locks/staged work, and
recovers its own abandoned process/index locks. Abandonment requires proof that
no push was attempted; a lost SSH response cannot establish that.

Local verification: **17 source-editor tests and 11 inspection tests pass**,
with real Git objects, a local bare remote, the reviewed Python renderer, and
OpenSpec 1.2.0. Only SSH transport is redirected in these tests. Both real OS and
Core changes also pass preview/source-model verification without changing their
canonical workspace. Their regenerated decks pass host inspection and native
strict validation; that inspection's remote query is simulated. The authoring
package now tracks deletion-only changes in its source SHA and dirty flag, with
95 focused Python tests passing. These are not deployed or storage-race results.

The executor is now exposed through the company-scoped SDK ports
`executionWorkspaces.editSources` and `abortSourceEdit`, requiring the explicit
`execution.workspaces.edit` capability and an active human member. Migration 0236
adds a protected source-writer pointer to native case work. Apply takes the
dispatch/workspace/case locks, verifies ended execution and released checkouts,
and parks the existing preparation issue on a new waiting turn. Its durable
operation pins the company, owning plugin, actor, case/version, turn, workspace,
base commit, and immutable request digest. Reservation clears approval evidence.

Native transitions, evidence, checkout/run claims, task handoffs, issue/workspace
rebinding, and workspace cleanup refuse a pending writer. Attempt leases can
expire for recovery without clearing that guard. Native revision publication
consumes only a matching completed Git receipt. Abandonment proves no push was
attempted; an unstarted operation receives a durable cancellation so a delayed
Apply cannot run afterward. Stale queued agent turns remain refused after the
source writer releases its reservation.

Current local checks: SDK build and direct server typecheck pass; SDK/checkout
regressions have **47 passed, 35 skipped**. Inspection/storage suites have
**11 passed, 22 skipped**: all seven new writer storage tests and fifteen case-work
tests skip because PostgreSQL sockets are unavailable. The stored receipts and
native race behavior still require actual database execution. The companion
Studio plugin has direct source previews, durable Apply/recovery, diff/impact
and base/latest/proposed comparison, and restore through a new revision, with
84 plugin tests passing. Scoped assisted requests, standard/incomplete draft
inspection, remote environment realization, the full real-storage/browser pilot,
assembly, and reviewed deployment remain unfinished.

The executor's follow-up recovery run passes **19 real Git/CLI tests**. It now
abandons an operation with a journal proving no push attempt even if another
actor advanced the local or remote branch. Cancellation preserves that other
actor's files and refs. An attempted push still refuses abandonment, including
when its response is lost. Direct server typecheck also passes after this change.

## Scoped preparation handoff checkpoint (2026-09-28)

Handoff accepts optional expected case-version and source-revision pins. The
native service checks them under its existing case/work locks, after immutable
request replay and before changing assignment. A scoped request cannot dispatch
against a case or source changed since composition. Replaying an accepted request
still returns its original receipt after later case changes. Existing callers
retain their existing handoff contract.

The companion plugin now saves scoped natural-language requests and patches with
authenticated operator/agent/run attribution. A scoped Author proposes source
only, then parks the same issue for operator preview and Apply. These turns cannot
publish source or advance directly to the Editor; retry context retains the
original request scope. Lost save/start responses reuse that request.

Current checks: direct server TypeScript passes. The focused host run reports
23 passed, 16 skipped, 8 failed. Sixteen case-work scenarios, including the new
precondition/replay check, skip for unavailable PostgreSQL sockets. Eight HTTP
route scenarios fail with `listen EPERM`. The plugin has 100 passing tests plus
typecheck/build. Its real SQL migrations and request/patch/operation restart
semantics pass in PostgreSQL WASM; this does not establish native multi-connection
race behavior. The full host checks and live pilot remain incomplete.

## Workspace environment checkpoint (2026-09-28)

Fixed inspection/edit programs now resolve the case's environment before choosing
an execution transport. The current checkout must have a matching company,
workspace, issue, and live lease. Ambiguous, orphaned, expired, and foreign leases
are refused. Without an active lease, the persisted realization remains
authoritative; legacy workspaces retain the placement in their lease history.
The preparation agent and instance default supply placement only for a workspace
with no recorded placement. A Git worktree path alone no longer
permits host-local execution. Company bindings and managed-sandbox/Kubernetes
execution policy also apply to these programs. An existing lease's actual
provider cannot be relabeled by changing the environment configuration.

SSH uses its process transport and the correct staged run directory; its
environment driver has no generic execute method. An in-place realization uses
its authoritative root. Operator operations can reacquire and realize that
persistent remote workspace with a company-checked ad-hoc lease, require the same
root, then release only their own lease. An agent's borrowed lease is not released.
Acquisition and realization share the command deadline; timed-out receipts cannot
validate a source, and lease cleanup failures remain explicit.

Copy-based remote workspaces without a live lease still require staging,
restoration, and durable Git-journal recovery. They report
`workspace_environment_unrealized` rather than running the host mirror. Actual
provider acquisition, remote persistence across lease replacement, concurrent
native storage, and the full pilot remain unverified. This checkpoint does not
complete workspace acceptance or authorize live write activation.

Verification: **27 environment tests pass**, covering placement history, company
and policy checks, lease ownership, SSH transport, ad-hoc realization/release,
deadlines, and timeout receipts with simulated environment ports. **30 existing
Git/CLI tests pass** using real temporary repositories and local transport shims
(19 editor/recovery and 11 inspection tests). Seven native writer storage tests
skip; the current support probe reports `listen EPERM: operation not permitted
127.0.0.1`. Direct server TypeScript passes. The combined run was 56 passed and
7 skipped; the later environment-only run includes the additional lease-history
test and passes all 27. These results do not establish actual provider behavior
or a green full-repository gate.

## Durable source candidate checkpoint (2026-09-28)

New native Apply reservations use a prepare/publish protocol. The fixed executor
first validates and renders the proposed source, then exports its exact two-commit
candidate as a Git bundle without pushing or changing the canonical files, index,
or branch. The host stores the request-bound candidate and a publication-dispatch
marker under the native attempt token before calling Apply. Both phases share
one execution deadline. A failed checkpoint write cannot dispatch publication.

The candidate includes its original timestamp, source/deck commit IDs, source
digest, and hashed bundle. Bundles are capped at 4 MB before base64 encoding;
oversized preparation fails before publication. These fields are internal host
data, excluded from the strict plugin request schema. The executor can import the
candidate into a fresh clone and converge on the same remote commit after a lost
push response. It does not regenerate the deck or choose another commit on retry.
Native error handling merges into current operation metadata so an execution
failure cannot erase the candidate or dispatch marker. The final receipt must
match that stored candidate.

Preparation can be abandoned without a surviving sandbox. Once publication was
dispatched, an uncertain outcome requires resuming that exact candidate; even a
transport failure before an actual push remains conservative. Existing operations
without this protocol still require their original workspace journal to prove
abandonment. Process-lock recovery now checks the host and Linux PID namespace;
another environment's PID table cannot authorize deleting its lock.

Automatic staging/restoration of copy-based environments remains unfinished. The
existing generic adapter restore cannot be assumed to preserve source-edit Git
journals or concurrent staged changes. Transport must also preserve the original
base commit when a shallow replacement starts at the published candidate. The
new protocol supplies durable candidate recovery, not proof of that full lifecycle.
Native database concurrency, real provider execution, full repository gates,
deployment, and both-repository pilot evidence remain outstanding.

Verification: **69 tests pass** (24 real Git/CLI source-edit tests, 7 checkpoint
protocol tests, 27 environment tests, and 11 inspection tests). Ten native writer
storage tests skip because opening `127.0.0.1` is denied by this sandbox. Direct
server TypeScript passes. Receipts are
`/private/tmp/openspec-durable-source-regressions.log` and
`/private/tmp/openspec-durable-source-types-final.log`. The current GitHub SSH
probe still fails DNS resolution, and the Paperclip CLI health request still
reports `fetch failed`; no runtime publishing or provisioning occurred.

## Copied workspace execution checkpoint (2026-09-28)

Unleased copy realizations now acquire and validate their own environment lease,
then stage a private committed checkout through the adapter's command-based
transport. SSH commands use the SSH process transport; sandbox commands use the
environment runtime. The host snapshot is pinned to the requested source commit,
even when its canonical checkout already contains the recovered candidate. Local
ignored/uncommitted runtime files are not transferred. Each attempt has a unique
remote directory; a completed command cleans that directory, and uncertain or
failed attempts release their own lease with failed status. Existing active copy
leases retain their ownership and return their canonical restoration coordinate.

Successful remote publication is checkpointed before host restoration. The host
then imports the recorded Git candidate and uses the source writer's exact ref,
file, and index guards. It does not run the renderer/OpenSpec CLI, query the
remote, or push during restoration. Competing staged work survives a conflict.
After a restore failure or host-process crash, the native operation resumes this
local restoration without acquiring another remote lease or publishing again.
The same preparation issue remains reserved until canonical publication finishes.

The adapter's default history depth remains one. Source operations request enough
ancestry to cover the last source-input change and its parent, so copied-deck
inspection can prove the input commit instead of treating the generated deck
commit as a history root. Candidate repositories also carry their source clone's
shallow boundary; object alternates alone are insufficient for Git publication.
Legacy writes without a durable candidate cannot reconstruct an uncertain copy
operation from a fresh directory and remain explicit reconciliation cases.

Real transfer tests use the actual adapter archive/Git scripts with separate host
and remote directories; only environment RPC and the SSH remote endpoint are
simulated. They exercise publication, ignored-file exclusion, staging the original
base after host advancement, source-history inspection, preservation of competing
staged edits, and recovery after interruption between ref and index updates.
Both server and adapter-utils TypeScript checks pass. Actual provider sessions,
native database concurrency, the full repository gate, deployment, intake,
delivery handoff, and the both-repository pilot remain required.

Verification across the relevant runs: **213 unique tests pass** (80 host and
133 adapter tests); eleven native writer database tests skip because this sandbox
cannot open the required local socket. The first combined run passed 194 tests
and failed 18 adapter restore cases solely on writes to the protected default
Paperclip lock directory. Rerunning those two adapter files with
`PAPERCLIP_HOME=/private/tmp/openspec-copy-adapter-test-state` passes all 102 tests;
the Git workspace file's 31 tests had already passed. The final ownership-boundary
run passes 41 tests and skips the eleven database cases. Receipts:
`/private/tmp/openspec-copy-regressions.log`,
`/private/tmp/openspec-copy-adapter-regressions-isolated.log`,
`/private/tmp/openspec-copy-boundary-final.log`,
`/private/tmp/openspec-copy-types-final.log`, and
`/private/tmp/openspec-copy-adapter-types.log`.

GitHub connector readback confirms initial authoring PRs OS 671 and Core 407 are
merged. GitHub SSH still fails DNS resolution and the live Paperclip CLI health
request still reports `fetch failed`. No runtime publishing or provisioning was
performed. These focused checks do not establish the full repository gate or
live provider/native database acceptance.

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

The missing Rust toolchain was installed. A later full server test shard failed
38 tests in 11 files (5,148 passed, 23 skipped). The failures include adapter and
workspace/environment suites; they have not all been established as baseline
failures. This is not a clean full-suite result.
The UI token gate reports nine pre-existing color literals in
`ui/src/components/onboarding/PillGuy.tsx`. This change adds no visual tokens.

## Remaining delivery work

Complete source editing/publication execution, the agent scheduler, dossier
feedback UI, controlled intake, and delivery handoff. Run the complete isolated
pilot and recovery matrix before live provisioning. Do not activate the
production evidence policy from these partial checks alone.

## Local runtime checkpoint (2026-09-28)

- Native case work binds one issue, records immutable turns/results, waits for
  checkout release and terminal runs, and rejects direct reassignment or agent
  completion. Turn-pinned wakes serialize with handoffs. Case approval/reopen
  completes/reopens the same task. The pre-sandbox focused run passed 54 tests
  across work turns, stage evidence, and orchestration APIs.
- Authorized plugin ports cover case list/create/link/patch/events/transition,
  immutable source identity publication, and conditional task handoffs.
- Native case annotation routes support questions, suggestions, blockers,
  replies, explicit disposition, optimistic concurrency, and reattachment.
  Source locators check revision, artifact title, file hash, heading, quote,
  and context. Document writes/restores remap within their transaction. Removed
  or ambiguous anchors remain open. Approval checks blockers on every case
  document, including documents omitted from the new packet.
- `executionWorkspaces.inspectRevision` is separately capability-gated and
  requires the owning plugin, company, case, task, workspace, version, and turn.
  It runs host-owned inspection in the realized execution environment. It
  accepts no arbitrary command/path. Git checks require the bound SSH origin,
  clean branch, exact commit, remote branch equality, regular UTF-8 blobs, and
  bounded source paths/bytes. The installed OpenSpec CLI validates a temporary
  snapshot. The repository's renderer code is read as source, not executed by
  this inspection port. Only factory-pipeline-v2 inspection is supported so far.
- Latest local inspection/anchor run: **14 passed, 5 skipped**. Real Git objects
  and the installed OpenSpec CLI are exercised; only the remote query is
  simulated. Native storage tests skip because the current sandbox prohibits
  local sockets. The bridge/SDK regression run has **7 passed, 35 skipped**.
  These skips do not replace the earlier real PostgreSQL results or prove the
  new database behavior. Shared/SDK builds and direct server/UI typechecks pass.
- Migration 0235 was generated from the schema. Numbering and safety checks
  passed using `node --import tsx` to avoid the CLI's prohibited IPC listener.

Current writable checkout: `/private/tmp/openspec-studio-runtime-host`, branch
`codex/openspec-studio-host`. The earlier worktree became read-only when session
permissions changed. This checkpoint is local, unprovisioned, and undeployed.

## Preparation review recovery (2026-09-28)

Native agent review decisions now require the current Reviewer's immutable turn
result and active run. Every decision event includes that result ID, turn, source
revision, and digest, including adverse decisions that do not carry an approval
packet. The plugin can recover a committed decision without parsing prose or
impersonating a finished run. A parked human/waiting turn can explicitly re-review
the current published source using a prior Editor/Reviewer result, retaining the
same issue. Review handoffs refuse a source head that advanced before commit.

Source feedback and the plugin UI share the heading-path calculation used for
native locator verification and conservative remapping. Stored browser-form
repository metadata may identify the same GitHub repository; actual inspection
input, Git origin, and remote queries still require SSH. Evidence allows up to
512 document pins, covering the bounded source inventory and derived documents.

The plugin coordinator and human feedback UI now have 52 local tests, including
simulated handoff/verdict response loss and DOM interactions. The host regression
run has 22 passed and 59 skipped; workspace inspection has 9 passed with a
simulated remote Git query. New parked re-review and verdict/result database
tests are among the skips: local sockets remain prohibited. Direct server
typecheck and migration checks pass. `pnpm -r typecheck` stops at the database
package's `tsx` IPC listener, and installed Chrome aborts in this sandbox. These
checks do not satisfy the real-storage pilot or the full repository release gate.

## Artifact input validation (2026-09-28)

Inspection now includes repository/change configuration and every schema template
format in the committed source manifest. It calls the installed OpenSpec CLI for
each artifact's instructions and dependencies, then fingerprints the actual
outputs and transitive inputs. An upstream change invalidates downstream input
fingerprints even when those output files still exist unchanged. The receipt
exposes this graph through the SDK. Historical receipts without the graph remain
readable but cannot establish artifact readiness in the plugin.

The plugin requires an accepted Author assessment of every current input/output
pair and pins that assessment as `spec-artifacts` in technical and human evidence.
Its dependency view distinguishes file presence, draft, stale, and validated
states and exposes exact files, reasons, and actor/run attribution. Local checks:
60 plugin tests, 10 host inspection tests, SDK build, and plugin typecheck/build
pass. Inspection tests use real Git/CLI with only the remote query simulated.
Incomplete-draft inspection, standard schemas, live storage/browser acceptance,
and the full delivery work above remain outstanding.

## Durable execution recovery (2026-09-28)

Case work now exposes a bounded read model of its native wake/run receipts.
Replayed turn wakes reuse those receipts after response loss, including when the
run has already ended. Deferred wakes, unknown receipts, and scheduled retries
cannot be mistaken for missing or terminal execution. Handoffs inspect active
runs associated with the issue even if its checkout/execution pointers were
cleared. A resultless recovery can retry only the same role/agent/revision, or
park the task; it cannot manufacture a review result or skip ahead to approval.
Recovery records the terminal run ID in native events and activity.

Heartbeat claim checks the bound case/turn/plugin again, including in the atomic
queued-to-running update. Delayed continuations for an old turn are cancelled
even when the same agent owns the next turn. Ordinary unbound issues retain
their existing claim path. The plugin repairs missed wakes, retries one ended
resultless turn, then parks a second failure for the operator.

Current local checks: **66 plugin tests**, plugin typecheck/build, SDK build, and
direct server typecheck pass. Focused host recovery/heartbeat/bridge regression:
**11 passed, 80 skipped**. Fifteen case-work storage scenarios are among the
skips; the sandbox prohibits local sockets. This is not native-storage or race
acceptance and does not satisfy the full host release gate.

## Draft inspection and editing (2026-09-28)

The inspector and editor now share a committed-tree collector. It resolves the
selected CLI schema, records incomplete artifact graphs and strict validation
diagnostics, and returns verified source even when the factory deck is missing
or invalid. Standard schemas do not acquire a synthetic deck requirement. Git
identity, clean-workspace, SSH transport, path, UTF-8, and size checks remain
mandatory at the enclosing execution boundary.

An explicit edit can publish an incomplete draft. Factory edits run only the
pinned renderer and remove obsolete deck output after an ordinary authoring
failure; standard-schema edits do not execute that renderer. The SDK receipt
includes canonical source, CLI diagnostics, and a Boolean readiness result.
Draft publication retains the shared preparation issue and invalidates review
readiness. Agent ready results and human approval still require validated source.

The candidate's second commit binds the inspection metadata digest. That
metadata travels in the durable checkpoint alongside the fixed Git bundle, and
copied publication receipts must preserve both its digest and validation result.
Recovery rereads the committed bytes without network, CLI, or renderer execution;
removed/changed metadata cannot upgrade a draft to a legacy validated result.

Focused checks pass: 32 real Git editing/copy tests, 15 inspection tests, ten
durable-publication tests, and 114 plugin tests. The Git integration suite now
allows 60 seconds per case for full CLI inspection and recovery round trips;
the initial 15-second timeout caused one failure, but both affected cases and
the subsequent complete run pass. Direct server/plugin typechecks, SDK build,
and plugin build pass. Actual OS/Core package previews preserve counts and leave
canonical files/index/refs unchanged, with network commands prohibited. A ready
standard-schema edit created through the CLI also publishes and replays through
a local bare remote with no renderer, retaining its unrelated old HTML artifact.
These local checks do not establish native database concurrency, real
provider/browser acceptance, deployment, or live provisioning.

## PR rollout preparation (2026-09-28)

The host integration targets this fork's `backlit-main` branch. The PR workflow
previously selected only upstream `master`; it now selects both branches so the
fork PR receives the same policy, typecheck, and test jobs. Product code remains
in the private plugin. The host changes are the shared case/evidence/workspace
capabilities it requires.

The three required local handoff commands were attempted again. `pnpm -r
typecheck`, `pnpm test:run`, and `pnpm build` stop on the sandbox's denied `tsx`
IPC listener. Migration ordering and the no-git-push guard pass. The token gate
reports nine colors in `PillGuy.tsx`; that file is byte-identical to the fork
base. These results do not make the PR ready for merge. Hosted checks, native
storage/provider tests, and review must pass before the OS assembly pin advances
to the merged host commit. SSH publishing and live API health are unavailable
in this session; no PR or deployment has been created by this checkpoint.

## Persistent rollout checkout (2026-09-28)

The temporary runtime checkouts were unavailable when publication resumed. The
host source was restored from the recorded patches onto the preserved foundation.
The two later migrations were regenerated from their schema checkpoints; their
SQL names and ordering are retained. New commits replace the unpublished
checkpoint hashes above. Full local and hosted checks are being rerun before
merge. This recovery does not establish the remaining provider or product pilot
acceptance.
