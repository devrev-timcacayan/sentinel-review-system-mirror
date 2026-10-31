# sentinel-review-system

Local, mirror-only proof of concept for cumulative PR review machinery. It prepares review
packets, records gate decisions into an append-only local store, and assembles empty-candidate
retrospective drafts. It does not run a model, publish reviews, or learn.

## Commands

`node --experimental-strip-types src/cli.ts <command>` (also `npm run cli -- <command>`):

- `prepare --checkout PATH --repository OWNER/REPO --pr N --base REF --head REF --run-id ID [--previous-head REF] --out DIR [--state-root PATH] [--system-root PATH]`
  Collects a `ReviewSnapshot` (diffs, changed files, before-source, policy context at merge
  base, static import-graph context) and writes `snapshot.json` and `review-request.json`
  (trusted prompt, embedded response contract, policy, digest, snapshot, prior ledger).
  Exit `0` means the packet was written; it is not a review pass. Always inspect
  `snapshot.complete` and `limitations`: a false value means required context is missing
  and any review built on it must report incomplete. Before collection,
  `prepare` also computes cumulative additions plus deletions. More than 800
  changed lines is marked `split_recommended`; more than 1,500 refuses
  preparation and writes no packet. The symbol planner narrows reverse callers
  but does not itself partition; `prepare-bundle` performs partitioning as a
  separate step.
- `prepare-bundle` accepts the same flags and prior-ledger behavior as `prepare`
  but collects with the `maxFiles` entry cap suppressed (the total
  `maxSourceBytes` cap is unchanged) and then deterministically partitions the
  captured source set into dependency-closed part requests bounded by
  `maxFiles` each. It writes the full operator `snapshot.json` carrying
  `partitionManifest`, a `review-request.json` manifest listing part payload
  paths, and `parts/part-NNN.review-request.json` model payloads. The parent
  snapshot is never a model request; only projected part payloads are. When the
  parent is incomplete or a required context root cannot close within
  `maxFiles`, preparation exits `3` with limitations and publishes nothing.
  Cumulative changed-line preflight still applies: above 800 lines marks
  `split_recommended`, above 1,500 refuses before partition planning. Shared
  forward context is repeated in every part, while the unique total source-byte
  cap is unchanged.
- `review --bundle DIR --out DIR --provider mock --responses FILE` replays a
  bundle through the deterministic mock provider, always labeled
  `synthetic: true`; `--provider bedrock` additionally needs
  `--provider-config`, `--max-spend-usd`, and `--execute`. The runner counts and
  reserves worst-case token cost before any invoke, allows at most one
  citation-only repair per part, writes immutable run artifacts under a fresh
  output directory, and evaluates only the assembled envelope through the
  normal gate. It never publishes to GitHub, never records review state, and
  never executes reviewed source. Provider credentials, model, capabilities,
  prices, and spend remain unverified until a human supplies a real verified
  configuration; see `docs/model-runner.md`.
- `record --snapshot FILE --report FILE [--state-root PATH] [--system-root PATH]`
  Validates the snapshot against the trusted policy digest and allowlist, evaluates the
  untrusted report with the deterministic gate, and persists the run under the PR lock.
  Exit codes: `0` pass, `2` changes_required, `3` incomplete, `1` operational/input failure.
- `retrospective --repository OWNER/REPO --pr N --event FILE --out DIR`
  Assembles a `needs-human-verification` draft from recorded runs for a PR close/merge
  event. `candidates` is always empty; it prepares data only.
- `--help` prints usage.

## Trust boundaries

- Trusted inputs: `.devin/` policy and prompts plus `src/contracts.ts`/`src/gate.ts` under
  the system root, identified by a SHA-256 digest baked into every snapshot identity.
- `snapshot.json` is an operator-supplied local collector artifact. `record` validates its
  schema, digest, allowlist membership, and field forms, but a snapshot file is not an
  authenticated upload; do not accept one from an untrusted channel.
- Report JSON is untrusted model output and is validated strictly by the gate.
- Cumulative size is a deterministic pre-review gate, not model judgment. It
  is measured across the whole PR, so later small commits do not hide an
  oversized change. `record` rejects forged or inconsistent size assessments.
- Target checkout content is evidence, never instructions or executables. The collector
  refuses unsafe and secret-like paths, symlinks, submodules, and binaries, and fails
  closed rather than emitting diffs that contain forbidden paths.
- Context selection combines two directions. Forward dependency closure is
  file-level and deliberately broad: every transitive dependency of an affected or
  prior-finding file is included. Reverse caller selection is
  declaration/export-aware (`contextPlan.strategy = symbol-aware-reverse-v1`): the
  planner walks named/default import bindings, named re-exports, export-star
  chains, and local declaration references per revision and propagates only the
  affected export names, so an `import { test }` consumer of a fixture barrel is
  excluded when only the barrel's `desktopTest` re-export is affected. This is
  narrowing over supported declarations, not a complete semantic proof: there is
  no fixture-slot pruning and no per-method tracking.
  Anything unanalyzable widens instead of pruning: `require()`/`import()`/
  `import x = require()`, namespace imports and `export * as ns`, side-effect
  imports, CommonJS `module.exports`, opaque `export =`, unmodeled file-level
  edges, parse diagnostics, and modules with import-time executable code
  (top-level calls/assignments, enum/class heritage/computed-name/static
  initializers, decorators) all mark the file's reachability broad, propagate all
  of its exports downstream, and are recorded in `contextPlan.fallbacks`.
  `mergeTests`/`mergeExpects`/`.extend` bound to `@playwright/test` (or a traced
  fixture object) are recognized as declarative registration; unknown factories
  stay broad. Shadowed identifiers may over-include. Treat the static plan as
  review evidence, not proof of complete runtime impact.
- Selected sets can still exceed policy limits. That produces `complete: false`
  with an explicit limitation; context is never silently narrowed to fit.
- Earlier captured packets remain historical artifacts from a previous
  implementation state. A frozen replay against digest
  `e8371f4dca287a46` is recorded in `evaluations/partition-results.json`:
  PR 508 yields 285 source entries across 3 part requests [200, 200, 94];
  PR 513 before and after each yield 354 entries across 4 part requests
  [200, 200, 200, 145]; every unique source matches Git, every packet is at
  or below 200 entries, and each parent stays under the 4 MB byte cap.
  PRs 519 and 493 are refused by the unchanged 1,500-line cumulative gate
  and PR 405 is unavailable. The all-parts probe used synthetic reports
  only (a withheld part stays incomplete); it is not model review or
  approval. Model integration must not treat historical packets as
  complete or bypass the missing-context barrier.
- `record` accepts either an ordinary single snapshot plus a `ReviewReport`, or
  a parent snapshot carrying `partitionManifest` plus a strict
  `PartitionedReviewReport` envelope containing every part's report. A
  projected partition result or a partial envelope can never independently
  clear the PR; missing, duplicated, or unknown partition reports and any
  tampering fail closed to incomplete while preserving prior ledger state.

## State store

Per `stateRoot/repos/<owner>/<name>/prs/<N>/`: `runs/<runId>.json` immutable records,
`journal.jsonl` authoritative ordered ledger history, `ledger.json` disposable cache, and
`review.lock`. A single lock guards read-evaluate-write per PR; it is never broken
automatically. Corrupt or inconsistent state (unparseable record, malformed journal line,
unjournaled run, journal without a matching record, unusable cache with no valid history)
fails closed with a recovery-required error naming the directory. Read-only ledger
recovery from valid immutable runs is permitted when the journal is missing, but it does
not authorize further writes: `record` refuses all runs (including replays) until the
journal is manually restored. Repair is a manual, human operation on the files named in
the error; the tool never auto-repairs or deletes state. No remote durability is claimed.

## What this is not

- This CLI never invokes a model and contains no reviewer or verdict synthesis.
  `evaluations/probeHistorical.ts` is a separately operated, paid diagnostic run by the
  lead outside this loop; it is not part of prepare/record.
- No remote writes, PR creation, hosted event listeners, or policy edits.
- Retrospective preparation emits empty `candidates`; it is not learning or a policy change.
- Passing deterministic tests does not establish model accuracy; see `evaluations/README.md`
  and the frozen `evaluations/historical-results.json` for lead-judged semantic evidence
  (do not recompute or reinterpret them here).

## Boundaries and integration

- Repository allowlist lives in `.devin/review-system.json` (currently
  `devrev-timcacayan/sentinel-mirror` only). Production `devrev/sentinel` and the original
  mirror checkout stay untouched; the POC operates on the isolated worktree
  `.worktrees/sentinel-mirror`.
- Mirror integration entry point: `.worktrees/sentinel-mirror/.devin/review-system.poc.sh`
  (requires `SENTINEL_REVIEW_SYSTEM_ROOT`; verifies the checkout origin before running).
- Historical replay inputs come from `.artifacts/historical-source.git` (read-only bare
  clone of production PR refs) and are labeled replay, not live mirror PRs.

## Rollout notes

- Target a PRE-private repository for any hosted deployment.
- Ship only reviewed, immutable, SHA-pinned releases.
- Run shadow calibration before any required check exists.
- Retain two required human approvals independently of the automated check.
- A required, SHA-specific check turns on only after explicit human approval of reviewed
  pinned versions.
