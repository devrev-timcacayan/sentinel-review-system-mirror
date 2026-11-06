# Claude Code Action integration (hosted path)

This document describes the action-backed review path. The offline seams
(`prepare-agent`/`validate-agent` with `--offline true`) remain fully offline and
cannot consume action artifacts; the action path cannot consume synthetic
artifacts either (mode/synthetic/operational flags are validated as an exact pair).

## Status and blockers

This document describes implemented local code and its contract tests. The
staging POC requires, before any further run:

- A manual `workflow_dispatch` of `claude-code-review.yml` on `staging` with
  `pr_number` (e.g. `gh workflow run claude-code-review.yml --ref staging -f
  pr_number=529`). One required string input; no mode/base/head inputs, no
  probe job, no `pull_request_target` trigger on this staging template.
- The workflow follows the `staging` branch via `REVIEW_SYSTEM_REF`: prepare
  resolves it to one commit per run and passes that commit to the other jobs,
  every stage verifies its checkout matches it and is clean, and the resolved
  commit is recorded in the prepared request and state.
- The dedicated `SENTINEL_REVIEW_SYSTEM_READ_TOKEN` secret is used for the
  reviewer checkouts and must have read access to the review repository.
- Fixed limits: 15-minute timeout, 200 files, 4,000,000 source bytes, 200,000
  per-read bytes. There are no USD or turn caps on the manual path; recorded
  usage remains evidence for later refinement. Nothing else needs
  operator-provisioned env or readiness flags.
- `sentinel-review-state` was initialized on `devrev/sentinel` with an empty
  index at commit `978f6f58c3ad4befd4fbbc2613ab37b0f0d5cfca`. The runtime
  still fails closed on missing or corrupt state and never auto-initializes.
- The `sentinel-review` status context must be configured on staging
  before treating it as a mandatory merge check; this work does not configure
  branch protection or required checks and a dispatch success is not PR
  approval.
- Source-layout, restricted-tools, settings, and SDK trace-format facts come
  from lead source capture of the pinned action
  (`1d6de8cb0c237e7c15e9e1bdf973826ebae490cc`) and local `claude --help`.
  Historical runs (probe `41797946024`, checkout `41839027490`) are
  operator-reported evidence, not re-verified in this pass.

Legacy `pull_request_target` host paths still require the old
`SENTINEL_REVIEW_POC_APPROVED_PR` / `SENTINEL_REVIEW_CONTROLS_VERIFIED` flags
and positive numeric caps; those flags do not apply to manual dispatch.

## Stages (`cli action-host <stage>`)

The review stages, other than data-only `capture`, verify `GITHUB_ACTIONS=true`, `GITHUB_REPOSITORY=devrev/sentinel`,
`GITHUB_EVENT_NAME` `pull_request_target` or a `workflow_dispatch` on
`refs/heads/staging` with one `pr_number` input (a deprecated four-input
variant remains accepted and must match the live PR; provided SHAs are never
compared to `GITHUB_SHA`, which is the workflow-code commit). The reviewed
base/head are captured from the live PR API response, never from inputs.
Positive decimal run id/attempt, the
event payload (staging base, same-repo head, full 40-hex SHAs, `POC Test:
<desc>-DO NOT REVIEW` title), derives runId `gha-<run>-<attempt>`, and enforces
the reviewer pin. GitHub API calls are limited to:
`GET /repos/devrev/sentinel/pulls/N`, `GET
/repos/devrev/sentinel/actions/runs/RUN`, `GET` and `POST` on
`/repos/devrev/sentinel/issues/N/comments`, `PATCH` on
`/repos/devrev/sentinel/issues/comments/<id>`, `POST` to
`/repos/devrev/sentinel/pulls/N/reviews`, and `POST` to
`/repos/devrev/sentinel/statuses/<headSha>`
(fixed `sentinel-review` context: `start-status` pending,
`fail-status` error, `finalize` terminal decision). `start-status` and
`fail-status` deliberately do not require paid-control limits so a pending or
error status can be recorded even when preparation cannot start; they still
require approved-PR, pin, run, and live-PR identity.

Prepared request/checkpoint identity, current policy/model, report schema, and
artifact hashes are checked before investigation and finalization. Hashes detect
inconsistent artifacts; authenticity comes from this workflow's trusted
preparation job and run-scoped Actions artifact transport, not a signature.

- `reserve --source-checkout --state-checkout --out [--system-root]`: verifies
  API/run/state, prepares the action request, writes `request.json`,
  `report.schema.json`, `instructions.md`, `host-context.json`,
  `checkpoint.json`. On incomplete preparation exits 3 with artifacts but never
  pushes or invokes the model. If the cumulative diff exceeds the trusted
  `blockChangedLines` limit, preparation throws before any artifacts: reserve
  writes only `size-refusal.json`, emits `size_refused=true` and
  `timeout_minutes=1` outputs, and returns 0 without state writes or statuses.
  On success commits the pending reservation
  (`review: reserve PR N for RUNID`) and pushes fast-forward only.
- `check --source-checkout --state-checkout --prepared`: re-verifies identity,
  run, pin, pending reservation token/ledger, prepared artifacts, and unchanged
  controls before the credentialed step. No writes.
- `materialize --source-checkout --prepared --out`: exports the immutable
  base/head source view to `review-source/{base,head}/<path>` under the per-file
  read limit; non-required unreadable paths go to `omissions.json` and are
  listed in a trusted `# Omitted source` prompt section (capped at 50 entries),
  unavailable required paths exit 3, and an unreadable dependency neighbor of a
  changed path also fails closed as unavailable. Emits `prompt`, `claude_args`,
  `settings` to `GITHUB_OUTPUT`. The disk view is not a prompt packet and its
  total size is not bounded by the later validation cache's cumulative-byte
  limit.
- `refuse-size --prepared [--system-root]`: authorizes like the status stages,
  then strictly validates `size-refusal.json` against the live PR identity,
  run, and trusted `blockChangedLines`. Publishes the sticky summary with a
  `## Sentinel review: size_refused` body stating the changed-line count, the
  limit, and that the PR must be split (no review ran); posts a `failure`
  commit status; emits `canonical_decision=size_refused`; exits 2.
- `capture --out`: records `ACTION_OUTCOME`, `ACTION_CONCLUSION`,
  `ACTION_SESSION_ID`, `ACTION_STRUCTURED_OUTPUT` and copies the execution
  trace if it is a readable regular file under `RUNNER_TEMP`. Fresh 0700 dir,
  0600 files; payload is never echoed.
- `finalize --source-checkout --state-checkout --prepared --result --out`:
  re-verifies live identity, requires the pending reservation token matching
  this run, verifies the receipt via `verifyActionExecution` (model, limits,
  session, single-execution trace), runs `validateActionReview`, persists
  `${runId}-completed` state, pushes fast-forward, then publishes the
  `## Sentinel review` summary comment and, when a validated pass or
  changes_required decision has findings, a formal PR review. The comment is
  compact: the status, up to five reasons (a `+N more` line beyond that), a
  one-line-per-finding list, and the run link; no finding explanation or
  impact text. The review posts findings as inline comments anchored on
  head-side diff lines where the cumulative diff permits and as file-level
  comments otherwise, with `REQUEST_CHANGES` for changes_required and
  `COMMENT` for pass; a 422 on line anchoring retries once with every
  comment at file level. Reviews are per-run and never deduplicated; an
  incomplete decision posts no review. The comment is sticky: `finalize`
  lists the PR's comments first, patches the first `github-actions[bot]`
  comment carrying the `<!-- sentinel-review -->` marker, and posts a new
  comment only when none exists, so each run updates one comment instead of
  piling on. The comment is authored by `github-actions[bot]` because
  `GH_TOKEN` is the job's `GITHUB_TOKEN`; renaming the bot itself would
  require a GitHub App. Untrusted report fields are capped, flattened to one
  line, stripped of mention, HTML, and code-span characters, and rendered
  inside Markdown code spans while the trusted template stays literal
  Markdown. Exit 0/2/3/1. Only a pending reservation token matching
  this exact run is eligible; a completed or stale token fails closed with no
  publish or write. Publication failure after a pushed decision fails the job
  while retaining the ledger; a later operator-approved rerun is a separate,
  separately authorized run.

Branch protection/authorized write access on `sentinel-review-state` and
required-check enforcement still need operator verification; nothing here
provisions them. The final job retains the original `claude-auto-review` name.
Legacy default-branch comment responders can still execute from `main`
on new comments until a main-branch guard change is reviewed and promoted;
staging-only edits cannot prove them disabled, which is why published text
neutralizes `@` mentions.

State files: `index.json` (strict `{schemaVersion:1, repository:'devrev/sentinel',
pullRequests:<unique positive ints>}`) and `prs/N.json` (strict record with
`stateVersion` `gha-<run>-<attempt>` pending, `${runId}-completed` finalized,
`status` pending/pass/changes_required/incomplete, ledger with matching inner
repository/PR). Inconsistency fails closed; a PR absent from both is a valid
new registration; a record without index listing or vice versa is corruption.
Commits use a fixed sentinel identity with hooks disabled; pushes are normal
fast-forward with the token passed via a child-env credential header, never in
output or config. A non-fast-forward rejection is retried up to three total
attempts under the C locale: refetch the state tip, fail closed if it changed
this PR's own record (a same-PR race is never merged), otherwise reset to it,
merge the index, recommit, and push again. Never a force-push.

Legacy packet modules (snapshot/gate/state/partition runners) are retained
because the offline CLI, docs, and tests still reference them.

## Workflow files

`integration/sentinel-claude-code-review.yml` is the canonical template: a
manual `workflow_dispatch` with one required `pr_number` input and three
permission-separated review jobs (prepare: contents/statuses write plus
pull-requests/actions read; investigate: contents/pull-requests/actions read
plus id-token:write around the single pinned Claude Code Action call;
claude-auto-review: contents/pull-requests/issues/statuses write plus actions read,
with `always()` inside the dispatch guard).
`integration/retired-sentinel-review.yml` retires the old experiment. The
staging copy `.github/workflows/claude-code-review.yml` is a byte-identical
mirror; originals were preserved under the local, gitignored
`.artifacts/action-integration-verify/` directory, absent from a fresh clone.
The earlier probe job, mode/SHA inputs, `pull_request_target` trigger, and
CircleCI bridge were removed: manual dispatch is the only launch path. The
host still accepts a `pull_request_target` event or the deprecated four-input
dispatch for compatibility, but the current template exposes neither.

Changes pushed to sentinel-review-system `staging` apply to the next
dispatch with no Sentinel edit. Anyone who can push to the reviewer branch changes code that runs
with the final job's write permissions on Sentinel, so the branch needs
required-review protection before switching `REVIEW_SYSTEM_REF` to `main`.

On finalize, the sticky summary walks issue-comment pages while pages come
back full (`per_page=100`, then `&page=N`), stops on the first eligible
marker, terminates on a short or empty page, fails closed on any failed or
malformed page, and refuses after 20 full pages; only a marker comment
authored by `github-actions[bot]` is patched. A `changes_required` decision
posts a formal `REQUEST_CHANGES` review, which may affect mergeability
depending on repository review settings; this code does not configure the
status as a required check. Each run posts findings as a separate formal
review, so repeated runs add more reviews.

The ledger is persisted before publishing; a later publication failure fails
the job and withholds a success status and the decision output, but does not
roll back the persisted ledger. The fallback step records an error status in
that case. Historical cloud runs (probe `41797946024`, checkout
`41839027490`) are prior evidence, not re-verified here.

Contract notes worth knowing: the coverage cross-check that requires every
dependency neighbor in `relatedPaths` applies only to `reliability-impact`
entries; `sourceReads` is the validator's audit of what it actually loaded, found
absent, or verified present, not an input allowlist or proof that the model
inspected those files; coverage `relatedPaths` are verified by tree existence
only and are never loaded; `maxFiles` counts only evidence-only loads, so
changed-file entries are always allowed; `maxSourceBytes` still bounds every
load; the reliability-impact coverage entry is the only one with a neighbor check,
and that check is name/source presence, not proof of inspection; and evidence quote matching strips leading whitespace per
line (a whitespace-only line compares as empty) while all other content,
including internal and trailing whitespace, must match exactly. Reconciling a
prior finding `fixed` requires evidence on lines changed since the last
reviewed head (a previous-head delta must exist, and adjacent head lines
anchor deletion-only fixes) plus at least one citation on the finding's own
paths; `withdrawn` requires evidence on the finding's paths. A withdrawn
blocker cannot reappear at the same or a nearby site under any rule, a fixed
blocker cannot reappear under the same rule at a matching or overlapping site,
and allowed different-rule near misses are logged to the validation audit as
`resolutionOverlaps`. Accepted `fixed` resolutions whose changed-line
evidence lies outside the finding's files and their direct dependency
neighbors are likewise logged as `fixedEvidenceOutsideScope` for
shadow-period measurement. Known limits: the changed-line citation may come from
any file, not only the finding's files or their import neighbors; the delta
runs from the previous head to the current head, so upstream edits brought in
by a merge or rebase also count as changed lines; and only head-side prior
citations are shifted through the delta, so a base-side prior site is compared
by quote and unshifted lines.
