# Claude Code Action integration (hosted path)

This document describes the action-backed review path. The offline seams
(`prepare-agent`/`validate-agent` with `--offline true`) remain fully offline and
cannot consume action artifacts; the action path cannot consume synthetic
artifacts either (mode/synthetic/operational flags are validated as an exact pair).

## Status and blockers

This is implemented code plus offline contract tests, not an activated or
runtime-verified integration. Activation requires, before any paid run:

- `SENTINEL_REVIEW_CONTROLS_VERIFIED=true` is still unset; the operator must
  verify exact pinned-version behavior (tool isolation, settings, and the SDK
  message-array execution-trace format consumed by `verifyActionExecution`).
  The trace format was authored fail-closed but not proved by source capture,
  so it remains an activation blocker alongside runtime flag isolation.
- `SENTINEL_REVIEW_POC_APPROVED_PR=<number>` naming the one approved test PR.
- Explicit `SENTINEL_REVIEW_MAX_TURNS`, `SENTINEL_REVIEW_MAX_USD`,
  `SENTINEL_REVIEW_TIMEOUT_MINUTES`, `SENTINEL_REVIEW_MAX_FILES`,
  `SENTINEL_REVIEW_MAX_SOURCE_BYTES`, `SENTINEL_REVIEW_MAX_READ_BYTES`.
- `REVIEW_SYSTEM_SHA` 40-hex pin equal to the review-system checkout HEAD;
  the checkout must be pristine. The workflow maps
  `vars.SENTINEL_REVIEW_SYSTEM_SHA` to this env var.
- `GH_TOKEN`/`GITHUB_TOKEN` per job, and the private checkout secret
  `SENTINEL_REVIEW_SYSTEM_READ_TOKEN` for the review-system repository.
- The operational branch `sentinel-review-state` must already exist on
  `devrev/sentinel` with a valid `index.json`. It is provisioned out of band;
  the code fails closed on a missing/corrupt index and never auto-creates it.

## Stages (`cli action-host <stage>`)

The review stages, other than data-only `capture`, verify `GITHUB_ACTIONS=true`, `GITHUB_REPOSITORY=devrev/sentinel`,
`GITHUB_EVENT_NAME=pull_request_target`, positive decimal run id/attempt, the
event payload (staging base, same-repo head, full 40-hex SHAs, `POC Test:
<desc>-DO NOT REVIEW` title), derives runId `gha-<run>-<attempt>`, and enforces
the reviewer pin. GitHub API calls are limited to:
`GET /repos/devrev/sentinel/pulls/N`, `GET
/repos/devrev/sentinel/actions/runs/RUN`, and (finalize only) `POST
/repos/devrev/sentinel/issues/N/comments` with a sanitized validated summary
(mentions, HTML, and Markdown neutralized).

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
automatic PR activation. A `workflow_dispatch` trigger is present only to
prove that a manually dispatched run can select the staging ref at all; no
live dispatch has been run or proven. On dispatch, only the
`staging-dispatch-probe` job is eligible (`if: github.event_name ==
'workflow_dispatch'`): one bash step with empty permissions, no checkout, no
actions dependencies, no secrets, token grants, OIDC, model calls, state
updates, or publishing. All review jobs are gated to
`pull_request_target`, and the final job keeps `always()` inside that event
so it still runs on prepare/investigate failure but can never finalize on
dispatch. There is no CircleCI bridge and no dispatch-based review support;
dispatch is branch-selection feasibility only, and any cloud result remains
unverified.
