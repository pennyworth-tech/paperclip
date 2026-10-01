# Generation-owned release drain (version 1)

This API holds heartbeat execution during a VM release. It does not change agent
or routine pause state. The old `/api/instance/drain` GET, POST and DELETE remain
manual operator controls. Their live-run counts are observations, not quiescence
receipts. Release automation must use the contract below.

## Authentication and activation

Configure the host with `BACKLIT_RELEASE_DRAIN_OWNER_ID` (a stable release-service
identity) and `BACKLIT_RELEASE_DRAIN_TOKEN_SHA256` (64 lowercase hex characters:
the SHA-256 digest of an independently generated high-entropy release token).
Keep the token in the external release service's secret store. The host needs
only its digest. Neither setting is an agent or board API credential.

Send `Authorization: Release <token>` on each release request, without cookies.
The `Release` authentication scheme is deliberately distinct from board/agent
Bearer authentication. The request's `ownerId` must equal the configured identity.
Missing configuration, a wrong credential, or a broad board/agent credential
cannot authorize a release verb. Only these drain routes consume the credential.
Use the existing private host boundary and TLS when crossing a network.

The verifier inspects the entire Docker execution daemon via `DOCKER_HOST` or
`PAPERCLIP_RELEASE_DRAIN_DOCKER=enabled`. This must be the dedicated execution
Docker daemon (the VM's DinD sidecar), not a daemon that also runs the control
plane. Every live container blocks, including an unlabeled or paused container.
The verifier never assumes an idle devcontainer is stopped or kills an unknown
container. On an installation with no Docker execution domain, explicitly set
`PAPERCLIP_RELEASE_DRAIN_DOCKER=none` and leave `DOCKER_HOST` unset. Missing domain
configuration or failed Docker inspection produces a non-quiescent receipt.

First adoption requires all previous, uninstrumented hosts and their agent
processes to be stopped and checked by the deployment owner. Old revisions do
not register their local execution state and cannot participate in this protocol.
Do not mix old and new schedulers against a shared database. This is a bootstrap
requirement, not a receipt that this new API can issue for an old binary.

## Wire contract

All paths start with `/api`. All POST bodies use `application/json`. Request
schemas and the enforced receipt schema are exported from
`server/src/services/release-drain-runtime.ts`; the matching JSON Schemas are in
[`release-drain.schema.json`](./release-drain.schema.json).

| Method and path | Body | Result |
| --- | --- | --- |
| GET `/instance/drain/release` | none | Current drain state |
| POST `/instance/drain/acquire` | `{ "ownerId": "release-service", "generation": 0 }` | Active state with the next generation |
| POST `/instance/drain/verify` | `{ "ownerId": "release-service", "generation": 1 }` | Version 1 quiescence receipt |
| POST `/instance/drain/interrupt` | Same ownership tuple plus `runIds` and optional `graceMs` | `interrupted`, `interruptedRunIds`, `retryRunIds`, and the legacy drain view |
| POST `/instance/drain/clear` | Same ownership tuple | Inactive state, after fresh local verification and all-host acknowledgement |

The state shape is `{ active, startedAt, ownerId, generation, hostIds,
pendingHostIds }`. Times are ISO 8601 strings, or null when inactive. IDs are
strings. Generation is a nonnegative safe integer. `ownerId` is null for manual
and inactive drains. A legacy row starts at generation zero. Read the current
generation before acquiring; acquire increments it and returns the value to use
for verify, interrupt, and clear. Never infer a generation from time or reuse a
receipt from another acquisition. If an acquire response is lost, GET the state
and reconcile it; do not blindly acquire again.

Acquire rejects an active drain, including a preexisting manual drain. Drain
writes and experimental-setting patches serialize on the singleton settings row.
A stale owner or generation is rejected with HTTP 409 and no drain mutation.
Client settings patches cannot write any drain fields. Cloud managed-config
feature overlays never determine operational drain state. Malformed operational
state fails closed; an unrelated malformed feature does not erase the drain.

A manual POST takes over an active release drain and advances the generation.
Subsequent release writes conflict. A release clear cannot clear a manual drain.
Manual DELETE refuses an active release-owned drain. This preserves the operator's
ability to hold work while preventing a stale deployment from undoing that hold.

## Receipt and release sequence

1. Read and acquire the drain on the serving host. Retain its returned tuple.
2. Poll verify on each host that shares the database. Address the hosts directly;
   load-balanced requests alone do not guarantee that each host acknowledges.
3. If needed, interrupt an explicit list of owned running run IDs on their host.
4. Continue verifying until `quiescent` is true. Only then stage/promote/restart.
5. Verify on the replacement host, then clear with the original tuple.

A receipt contains `schemaVersion: 1`, the tuple, a per-process boot `hostId`,
`observedAt`, `locallyQuiescent`, `quiescent`, and `pendingHostIds`. It also contains:

- `runningCount`, `queuedCount`: database observations. Queued work may remain.
- `localProcessRunIds`, `processRunIds`: local handles and persisted process/group
  references that are alive or whose state cannot be established.
- `inFlightExecutions`, `lifecycleOperations`: local adapter/wakeup promises and
  maintenance/dispatch work that has not settled.
- `suppressionAcknowledged`: this service has observed the requested generation.
  Inactive drain values are not cached; old scheduler service objects read and
  register their boot before admitting work.
- `leaseIds`: outstanding leases, failed or unknown provider cleanup, and released
  reusable resources that have not been destroyed.
- `devcontainerIds`: every live container in the execution daemon; unknown
  ownership is a blocker, not a reason to omit a container.
- `liveServiceIds`, `orphanCleanupCount`, `unknown`: local managed services,
  buffered/spooled orphan cleanup, and failed or undeclared observations.

Only an empty local resource inventory, no in-flight work, and an acknowledged
suppression fence can persist this host's acknowledgement. `quiescent` additionally
requires every registered host to acknowledge. Verification errors do not clear
the drain. There is no timeout-based or TTL-based assumption that a host died.

The host registers before scheduling or maintenance. The durable host set survives
restart. An old boot that crashed before acknowledgement remains pending even if
the ledger says zero. Release automation must stop and escalate that condition;
it cannot take ownership of the old boot or fabricate its acknowledgement. An old
boot that acknowledged before a planned restart remains safe while the drain is
active. The new boot registers and verifies its own local state before clear.
Clearing retires the acknowledged set; any subsequent work registers again.

`prepareHotRestartShutdown`, `reconcileHotRestartAdoption`, `reapOrphanedRuns`,
`sweepPendingCleanupLeases`, `resumeQueuedRuns`, `promoteDueScheduledRetries`,
`sweepStaleIssueLocks`, and dispatch stay fenced while the drain is active. Work
already past a fence is counted until it settles. Independent pause settings are
never lifted. A process lookup error other than ESRCH remains unknown.

## Bounded interruption and retry

`runIds` has 1–100 UUIDs. `graceMs` defaults to 2000 and is bounded to 1–30000 ms
per process group, followed by the existing shutdown kill/verification timeout.
Use small batches within the release controller's own deadline. Never equate an
HTTP timeout with successful interruption; query and verify again.

Interruption extends the existing shutdown path. It validates local ownership
before signaling any selected running run. Database PIDs alone cannot authorize
a signal. Unknown ownership returns 409 without interrupting the selection.
The source is marked interrupted with `server_shutdown_interrupted`; its wakeup
is cancelled. The bounded-retry primitive serializes on the source run and queues
one retry for that source. Repeated/concurrent requests return the same retry ID.
Existing context, result checkpoints and persisted session checkpoints survive.
Paused agents remain paused; queued retries cannot dispatch under the drain.
A failed teardown retains the local process handle and durable process identity.
Same-boot requests can resume an interrupted source after a partial failure.

## Errors and operator checklist

- 400: invalid body or bounds.
- 401: release credential is absent, disabled, or invalid.
- 403: requested owner differs from authenticated identity.
- 409 `release_drain_conflict`: stale tuple or incompatible/manual drain.
- 409 `release_drain_not_quiescent`: clear has no complete receipt.
- 409 `release_drain_unknown_process`: interruption cannot establish ownership.
- Observation/DB errors never authorize clear. `verify` may return 200 with
  `quiescent: false`; inspect its evidence, not just the HTTP status.

Deployment owner activation checklist:

- Bootstrap the instrumented revision with the previous host stopped and checked.
- Provision the external release token, its host-side digest, and owner identity.
- Configure and grant read access to the dedicated Docker execution daemon, or
  explicitly declare no Docker domain on a host that has none.
- Route verify to each participating host and retain the immutable receipt with
  the release record. Test a manual-drain conflict and a hidden local execution.
- Treat unacknowledged crashed hosts, unknown containers/processes, and orphan
  cleanup as blockers requiring inspection; do not bypass the drain with a board
  key or edit generations to make automation proceed.

No production credentials, Docker daemon, or deployment activation are created by
this change. Tests use an isolated PostgreSQL database and real local children.
