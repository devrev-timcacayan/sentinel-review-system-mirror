# sentinel-review-system

A proof of concept that reviews pull requests under a strict contract, safely.

Three interfaces exist, with different responsibilities:

- **Hosted action path (active).** A manual `workflow_dispatch` on staging
  runs the Claude Code Action as the model reviewer and this system as the
  deterministic validator and publisher: it validates the model report
  against the canonical gate, reconciles ledger state on the
  `sentinel-review-state` branch, posts a sticky summary and eligible inline
  findings, and sets the `sentinel-review` commit status. See
  `docs/actions-integration.md`.
- **Offline agent seams.** `prepare-agent`/`validate-agent` (`--offline true`)
  validate fabricated reports end to end and publish nothing.
- **Legacy packet runner.** The `prepare-bundle`/`review`/`record` commands and
  the snapshot/gate/state modules run a mock review locally or an explicitly
  authorized Bedrock call. That path is local packet tooling, not the active
  Actions orchestration. Command examples below refer to it only.

> **Status: staging POC.** The hosted path is an opt-in manual experiment on
> `staging`, not production activation. The `sentinel-review` status it
> publishes is not itself a merge gate; production required-check
> configuration has not been verified by this local pass and this code does
> not configure it. Local verification proves the contract mechanics only;
> prior operator-reported cloud runs are historical evidence, not re-verified
> here.

## What it does

- **Prepares** an immutable review request for a PR: cumulative diff, changed
  files, related source reads under strict budgets, and pinned policy.
- **Reviews** the packet through a model: the Claude Code Action in the
  hosted path, or an offline mock replay locally.
- **Validates** the report against deterministic structural and reconciliation
  rules; nothing passes on shape alone.
- **Publishes** (hosted path only) a sticky bot-authored summary, a terminal
  commit status, and, when a non-incomplete decision leaves open findings, a
  formal inline review. The ledger commit lands before publishing; a later
  publication failure fails the job and withholds a success status, but does
  not roll back that ledger commit.

## What it will never do

- Execute reviewed code: it is evidence, never run by the reviewer. Workflow
  code and the reviewer checkout are trusted pinned inputs.
- Skip checks silently. Missing context, wrong shapes, or tampered state all
  fail closed to "incomplete" instead of guessing.
- Let a replayed or synthetic result stand in for a current review.
- Treat a successful dispatch as PR approval or merge authorization.

## Requirements

- Node.js 22+ (the CLI runs TypeScript via `--experimental-strip-types`)
- Git
- Optional: a verified AWS Bedrock provider config for real model calls

## Get started

```bash
npm install
npm test            # offline test suite
npm run typecheck
```

## Legacy Packet Commands

| Command | What it does |
|---|---|
| `prepare` | Builds a review packet for one PR. PRs over 1,500 changed lines are refused; over 800 is flagged `split_recommended`. |
| `prepare-bundle` | Same, then splits big context into bounded part requests a model can actually read. |
| `review` | Sends the packet to a provider (`mock` replays fixtures offline; `bedrock` is the real path) and evaluates the reply. |
| `record` | Validates a report and permanently stores the decision. |
| `retrospective` | Prepares a human-verification draft for a closed PR. |
| `journal-migrate` | One-time upgrade for old state files, with a private backup first. |

```bash
npm run cli -- <command> --help   # or: node --experimental-strip-types src/cli.ts --help
```

## Legacy Packet Example

```bash
# 1. Build the packet and part requests
npm run cli -- prepare-bundle --checkout /path/to/repo \
  --repository devrev-timcacayan/sentinel-mirror --pr 12 \
  --base main --head feature --run-id demo-1 --out ./out/demo

# 2. Review it offline with the mock provider
npm run review -- --bundle ./out/demo --out ./out/run-1 \
  --provider mock --responses ./fixtures/responses.json

# 3. Store the evaluated report
npm run cli -- record --snapshot ./out/demo/snapshot.json \
  --report ./out/run-1/report.json
```

Exit codes for `record`: `0` pass · `2` changes required · `3` incomplete or
superseded · `1` operational failure.

## Safety rules, one line each

Legacy packet runner guarantees (the local path; hosted behavior lives in
`docs/actions-integration.md`):

- Everything is local except a model invocation you explicitly authorize with
  `--execute` and a spend cap.
- Checked-out code is evidence, never executed or trusted as instructions.
- Review history is append-only and chained; tampered or reordered state makes
  the tool refuse to continue rather than guess.
- Mock output is marked `synthetic: true`, and `record` refuses to store it.
- An old pass can't stand in for current state: replays report `superseded`
  once newer state exists.
- Files you didn't expect, secrets, binaries, symlinks, forbidden paths,
  abort packet creation instead of leaking into a review.

## Where the deep docs live

- `docs/model-runner.md`: the model runner contract (budgets, repairs, artifacts)
- `evaluations/README.md`: frozen evaluation evidence and its limits
- `policy/partition.prompt.md`: the trusted partition review protocol

## Boundaries

- Repository allowlist: `policy/review-system.json` includes
  `devrev-timcacayan/sentinel-mirror` and `devrev/sentinel`. The hosted
  workflow is staging-scoped; production main is outside this POC's scope.
- Legacy mirror integration entry point (local, gitignored, absent from a
  fresh clone): `.worktrees/sentinel-mirror/.devin/review-system.poc.sh`
- Rollout stays opt-in: human approvals remain required, and no required
  check turns on without explicit approval of pinned, reviewed versions.
