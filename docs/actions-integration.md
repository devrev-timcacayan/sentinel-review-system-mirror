# Claude Code Action integration (hosted path)

This document describes the action-backed review path. The offline seams
(`prepare-agent`/`validate-agent` with `--offline true`) remain fully offline and
cannot consume action artifacts; the action path cannot consume synthetic
artifacts either (mode/synthetic/operational flags are validated as an exact pair).

## Status and blockers

This is implemented code plus offline contract tests, not an activated or
runtime-verified integration. The manual staging POC requires, before any paid
run:

- A manual `workflow_dispatch` of `claude-code-review.yml` on `staging` with
  `pr_number` (e.g. `gh workflow run claude-code-review.yml --ref staging -f
  pr_number=529`). One required string input; no mode/base/head inputs, no
  probe job, no `pull_request_target` trigger on this staging template.
- `REVIEW_SYSTEM_SHA` is pinned literally in the workflow (current value is a
  temporary commit pending the adapter pin); no variable substitution.
- The existing `CLAUDE_REVIEW_PAT` secret must have read access to the review
  repository; no new secrets were created.
- Fixed limits: 15-minute timeout, 200 files, 4,000,000 source bytes, 200,000
  per-read bytes. There are no USD or turn caps on the manual path; recorded
  usage remains evidence for later refinement. Nothing else needs
  operator-provisioned env or readiness flags.
- `sentinel-review-state` was initialized on `devrev/sentinel` with an empty
  index at commit `978f6f58c3ad4befd4fbbc2613ab37b0f0d5cfca`. The runtime
  still fails closed on missing or corrupt state and never auto-initializes.
- The `sentinel-canonical-review` status context must be configured on staging
  before treating it as a mandatory merge check; this work does not configure
  branch protection or required checks and a dispatch success is not PR
  approval.
- Source-layout, restricted-tools, settings, and SDK trace-format facts are
  confirmed by lead source capture of the pinned action
  (`1d6de8cb0c237e7c15e9e1bdf973826ebae490cc`) and local `claude --help`, not
  by a successful cloud model run; runtime behavior is still unverified.

Legacy `pull_request_target` host paths still require the old
`SENTINEL_REVIEW_POC_APPROVED_PR` / `SENTINEL_REVIEW_CONTROLS_VERIFIED` flags
and positive numeric caps; those flags do not apply to manual dispatch.

## Stages (`cli action-host <stage>`)

The review stages, other than data-only `capture`, verify `GITHUB_ACTIONS=true`, `GITHUB_REPOSITORY=devrev/sentinel`,
`GITHUB_EVENT_NAME` `pull_request_target` or an explicit `mode: review`
`workflow_dispatch` on `refs/heads/staging` (exact inputs: approved PR number,
`base_sha` equal to `GITHUB_SHA`, `head_sha`), positive decimal run id/attempt, the
event payload (staging base, same-repo head, full 40-hex SHAs, `POC Test:
<desc>-DO NOT REVIEW` title), derives runId `gha-<run>-<attempt>`, and enforces
the reviewer pin. GitHub API calls are limited to:
`GET /repos/devrev/sentinel/pulls/N`, `GET
/repos/devrev/sentinel/actions/runs/RUN`, and `POST` to
`/repos/devrev/sentinel/issues/N/comments` (sanitized summary: mentions, HTML,
and Markdown neutralized) and `/repos/devrev/sentinel/statuses/<headSha>`
(fixed `sentinel-canonical-review` context: `start-status` pending,
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
  pushes or invokes the model. On success commits the pending reservation
  (`review: reserve PR N for RUNID`) and pushes fast-forward only.
- `check --source-checkout --state-checkout --prepared`: re-verifies identity,
  run, pin, pending reservation token/ledger, prepared artifacts, and unchanged
  controls before the credentialed step. No writes.
- `materialize --source-checkout --prepared --out`: exports the immutable
  base/head source view to `review-source/{base,head}/<path>` under the per-file
  read limit; non-required unreadable paths go to `omissions.json`, unavailable
  required paths exit 3. Emits `prompt`, `claude_args`, `settings` to
  `GITHUB_OUTPUT`. The disk view is not a prompt packet and its total size is
  not bounded by the later validation cache's cumulative-byte limit.
- `capture --out`: records `ACTION_OUTCOME`, `ACTION_CONCLUSION`,
  `ACTION_SESSION_ID`, `ACTION_STRUCTURED_OUTPUT` and copies the execution
  trace if it is a readable regular file under `RUNNER_TEMP`. Fresh 0700 dir,
  0600 files; payload is never echoed.
- `finalize --source-checkout --state-checkout --prepared --result --out`:
  re-verifies live identity, requires the pending reservation token matching
  this run, verifies the receipt via `verifyActionExecution` (model, limits,
  session, single-execution trace), runs `validateActionReview`, persists
  `${runId}-completed` state, pushes fast-forward, then publishes the
  sanitized comment. Exit 0/2/3/1. Only a pending reservation token matching
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
output or config.

Legacy packet modules (snapshot/gate/state/partition runners) are retained
because the offline CLI, docs, and tests still reference them.

## Workflow files

`integration/sentinel-claude-code-review.yml` is the canonical template with
three review jobs (prepare/check/finalize split of contents:write,
contents:read + id-token, contents:write) plus an isolated dispatch probe.
`integration/retired-sentinel-review.yml` retires the old experiment. Staging
copies at `/private/tmp/sentinel-staging/.github/workflows/{claude-code-review,
sentinel-review}.yml` are byte-identical mirrors; originals preserved under
`.artifacts/action-integration-verify/staging-originals/`.

GitHub's `pull_request_target` semantics are confirmed to run the
default-branch copy of a workflow, so these staging-only edits are not
automatic PR activation. `workflow_dispatch` accepts a `mode` input: `probe`
(the safe default) runs only `staging-dispatch-probe`, while `review`
requires exact `pr_number`/`base_sha`/`head_sha` inputs and runs the same
three review jobs against the live PR. Frozen cloud evidence: run
`41797946024` completed a `workflow_dispatch` probe on staging `22ecaa1` with
all three review jobs skipped and activation vars empty; that proves branch
selection only and is not paid-runtime verification. On dispatch the review
path validates inputs, live PR identity, run binding, approved-PR env, pin,
and controls before any state or model step, and publishes a fixed
`sentinel-canonical-review` commit status on the exact PR head (pending via
`start-status`, terminal via `finalize`, error fallback via `fail-status`);
that status context must be configured on staging before anyone treats it as
mandatory, and a successful dispatch is not PR approval. All review jobs are
gated to `pull_request_target` or an explicit `mode: review` dispatch, and
the final job keeps `always()` inside that condition.

An opt-in CircleCI bridge exists at `integration/dispatch-sentinel-review.ts`
(byte-identical mirror `scripts/ci/dispatch-sentinel-review.ts`): a staging
pipeline with `run_sentinel_review=true` and `sentinel_review_pr='529'`
routes to `.circleci/sentinel-review.yml`, which dispatches the canonical
workflow with immutable base/head resolved from the live PR. It requires the
`sentinel-review-dispatch` restricted context (provisioned out of band, no
broad automation context), `SENTINEL_REVIEW_DISPATCH_READY=true`,
`SENTINEL_REVIEW_DISPATCH_TOKEN` with Actions write plus contents/PR read for
this repository only, and the approved-PR flag — all of which remain
operator blockers. The bridge is a controlled launch route, not automatic
review on PR updates; automatic PR-head triggering stays out of scope until
trusted config/context setup is verified. The production `main` check is
unchanged.
