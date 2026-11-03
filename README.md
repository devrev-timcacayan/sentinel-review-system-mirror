# sentinel-review-system

A local proof of concept that prepares pull requests for automated review — safely.

In plain terms: it gathers everything a reviewer needs for a PR (the diff, the
changed files, and the related code), hands it to a model under a strict
contract, checks the model's answer against deterministic rules, and keeps a
tamper-evident record of every decision. It runs entirely on your machine.

> **Status: shadow mode only.** This is a proof of concept, not a merge gate.
> It must not block merges or publish reviews anywhere.

## What it does

- **Prepares** a review packet for a PR: cumulative diff, changed files,
  related source code, and trusted policy context.
- **Reviews** the packet through a model — an offline mock replay, or AWS
  Bedrock with your own verified config and an explicit spending cap.
- **Records** the report only if it passes strict structural checks, and
  stores each decision in an append-only local journal.
- **Drafts** a "needs-human-verification" retrospective when a PR closes.

## What it will never do

- Publish to GitHub, or change any repo or check settings.
- Run code from the repository being reviewed.
- Skip checks silently. Missing context, wrong shapes, or tampered state all
  fail closed to "incomplete" instead of guessing.
- Let a replayed or synthetic result stand in for a current review.

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

## The commands

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

## A typical flow

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

- Everything is local. The only network call is a model invocation you
  explicitly authorize with `--execute` and a spend cap.
- Checked-out code is evidence, never executed or trusted as instructions.
- Review history is append-only and chained; tampered or reordered state makes
  the tool refuse to continue rather than guess.
- Mock output is marked `synthetic: true`, and `record` refuses to store it.
- An old pass can't stand in for current state: replays report `superseded`
  once newer state exists.
- Files you didn't expect — secrets, binaries, symlinks, forbidden paths —
  abort packet creation instead of leaking into a review.

## Where the deep docs live

- `docs/model-runner.md` — the model runner contract (budgets, repairs, artifacts)
- `evaluations/README.md` — frozen evaluation evidence and its limits
- `policy/partition.prompt.md` — the trusted partition review protocol

## Boundaries

- Repository allowlist: `policy/review-system.json` (currently
  `devrev-timcacayan/sentinel-mirror` only). Production stays untouched.
- Mirror integration entry point:
  `.worktrees/sentinel-mirror/.devin/review-system.poc.sh`
- Rollout stays opt-in: shadow calibration first, human approvals remain
  required, and no required check turns on without explicit approval of
  pinned, reviewed versions.
