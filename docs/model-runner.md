# Local model runner (`npm run review`)

`src/reviewCli.ts` is a deep local seam between `prepare-bundle` artifacts and the
gate. It never publishes to GitHub, never mutates review state, never runs
`recordReview`, and never executes reviewed source. `evaluateReview` on the full
parent plus the assembled envelope remains the sole final gate.

## Inputs

- `--bundle DIR` from `prepare-bundle` (`snapshot.json` with
  `partitionManifest` plus the `partitioned-review-bundle`
  `review-request.json` carrying identity, manifest, part paths, and the
  captured prior ledger).
- `--out DIR` must be brand new; an existing directory refuses before any
  provider call (no automatic rerun, cache, or restamp).
- `--provider mock` needs `--responses FILE` (a strict
  `mock-review-provider` fixture) and forbids `--execute`,
  `--provider-config`, and `--max-spend-usd`. Mock output is always labeled
  `synthetic: true`, writes `mock-report.json`, and is offline replay, never a
  real review or PR approval.
- `--provider bedrock` needs `--provider-config FILE`, `--max-spend-usd USD`,
  and `--execute`. The example config at
  `.devin/bedrock-provider.example.json` is deliberately null and cannot run;
  credentials, model identity, capabilities, prices, and spend limits remain
  unverified until a human supplies a verified configuration.

## Execution contract

1. Preflight validates the snapshot, manifest completeness, ledger identity
   (`previousHeadSha === ledger.lastHeadSha`), provider config against the
   trusted policy model, and the positive spend cap, before any count or
   invoke.
2. Every part request is reconstructed from the trusted loaded policy and the
   parent (never from old request files), persisted with a sha256 hash, token
   counted, fit-checked, and worst-case reserved before any invoke.
3. Invokes run sequentially with immutable `intent.json` crash evidence.
   Replies require `end_turn`, valid nonnegative token usage within the counted
   bound, and text-only content. Transport failure, invalid usage, or usage
   overrun charges the full reservation conservatively, marks
   `uncertainCharges`, and stops remaining invokes. Uninvoked reservations are
   released at zero cost.
4. `inspectModelResponse` scopes each reply to its partition; only a
   citation-only repair is permitted once per part, separately counted and
   reserved, and must satisfy `isCitationOnlyRepair` (no dropped findings,
   severity changes, identity, coverage, completeness, or narrative edits).
   A failed or protected-field repair retains the original parsed report so
   the final gate stays incomplete.
5. The assembled `PartitionedReviewReport` envelope is always evaluated by
   `evaluateReview`. Missing parts stay missing; no synthesized pass is ever
   emitted.

## Accounting scope

Budget snapshots are integer microdollar strings. `count-tokens` usage and
configured prices are operator attestations; this is conservative per-run
model-token accounting, not AWS-account billing enforcement.

## Artifacts (mode 0600, directory 0700)

`snapshot.json`, `prior-ledger.json`, `provider-profile.json`,
`execution.json`, `parts/part-NNN/{review,repair}/{request,intent,response}.json`,
and exactly one of `mock-report.json` or `report.json`.

## Verification artifacts

`.artifacts/verify/bedrock-count-tokens-skeleton.json` and
`bedrock-converse-skeleton.json` are offline `--generate-cli-skeleton`
captures (no credentials, no calls) confirming the request shapes.
