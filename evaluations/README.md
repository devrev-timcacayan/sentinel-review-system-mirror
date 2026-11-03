# Evaluation Evidence

These are separate evidence streams, not interchangeable success criteria:

- `tests/`: deterministic contract, packet, and state behavior.
- `cases.json`: proposed semantic seeds with expected outcomes and acceptable
  counterexamples. Their presence is not an executed model result.
- `historical-results.json`: frozen, lead-adjudicated observations from selected
  historical revisions, including explicit blocked or unexecuted cases.
- `packet-results.json`: separately validated collector replays. A complete
  source packet is not a complete model review or an approval.
- `context-planner-results.json`: the first declaration/export-aware reverse
  planner replay, including the unchanged historical context-budget failures.
- `partition-results.json`: subsequent dependency-closed bundle preparation
  and explicitly synthetic all-parts gate probes, not model reviews.
- `.artifacts/semantic-probes/`: local raw model requests, responses, stderr,
  execution envelopes, and evidence-range checks. Ignored by Git.

## What The Historical Probes Establish

The bounded PR 513 probe detected the duplicate-ID oracle defect before its fix
and did not re-raise that mechanism against the paired fixed source. This is
useful evidence of a semantic review capability, not a full PR certification.

The model cited incorrect line ranges, including for its valid finding. Do not
relax exact-source validation to make those outputs pass. A future integration
should provide line-addressable source and use a bounded repair round that
retains the original output. Unrepaired or ambiguous evidence remains
incomplete. Do not silently move a quote to a different location.

The post-fix output contains other advisory findings and a question. Those
claims need independent adjudication, not automatic promotion into policy.

## Large PRs

PR 519 is a useful low-feedback control candidate. Its large raw diff includes
formatting churn around test-case annotations. Size and sparse comments do not
establish defects or prove that humans failed to inspect the code.

PR 493 is a separate coverage stress case, not a low-feedback example. It has
historical discussion and a binary asset. A text-only snapshot must disclose
that unsupported content and cannot call the packet complete.

The replay results expose a practical context-selection problem: file-level
imports through merged fixtures pull in broad unrelated implementations.
Several packets hit the source-entry budget, including the one-file PR 508.
The POC returns incomplete rather than narrowing away those callers or
silently treating omitted context as reviewed. Symbol-aware planning or
partitioned reviews need their own regression evidence before adoption.

## Context Planner Replay

The first planner stage routes affected export names through supported named
imports, aliases, local declarations, and re-exports. It retains full forward
dependencies and falls back to broader reachability for opaque syntax and
import-time effects. Controlled fixture tests establish that unrelated barrel
consumers can be excluded in supported cases. They do not establish complete
semantic impact analysis.

Historical replay under the unchanged limits did not solve context volume:

| Revision | Captured source entries | Omitted source entries | Result |
| --- | --- | --- | --- |
| PR 508 final | 200 | 85 | Incomplete |
| PR 513 before fix | 200 | 154 | Incomplete |
| PR 513 after fix | 200 | 154 | Incomplete |
| PR 519 | No new packet | Not assessed | Size refused: 9,512 changed lines |
| PR 493 | No new packet | Not assessed | Size refused: 6,017 changed lines |
| PR 405 initial | No new packet | Not assessed | Selected revision unavailable |

All captured source in the three newly prepared snapshots was checked against
its exact Git object. Original packets and their measurements were not
regenerated. No model or GitHub action ran.

`replayContextPlanner.ts` is an explicit local collector diagnostic. It reads
the ignored historical object store, selection manifest, and frozen packet
checks, then writes a new digest-keyed artifact directory. It refuses to reuse
that directory rather than overwrite prior results. Do not rerun it merely to
render these captured results.

At that first stage, partitioning and an all-parts-complete barrier were still
missing. Those original snapshots remain incomplete; the subsequent bundle
stage below does not retroactively certify them. More precise fixture-slot or
changed-hunk analysis is not demonstrated by either stage.

## Partition Bundle Replay

The subsequent bundle stage captures the full selected parent source set under
the existing 4,000,000-byte cap, then assigns dependency-closed context groups
to packets with at most 200 source entries each. Changed before/after source,
base policy context, prior-finding context, and their forward dependencies are
shared. Each assigned caller retains its transitive forward context.

| Selected revision | Unique source entries | Entries per packet | Preparation |
| --- | --- | --- | --- |
| PR 508 final | 285 | 200, 200, 94 | Source bundle prepared |
| PR 513 before fix | 354 | 200, 200, 200, 145 | Source bundle prepared |
| PR 513 after fix | 354 | 200, 200, 200, 145 | Source bundle prepared |
| PR 519 | No new packet | None | Size refused: 9,512 changed lines |
| PR 493 | No new packet | None | Size refused: 6,017 changed lines |
| PR 405 initial | No new packet | None | Exact revision unavailable |

An entry is a path/revision pair, so before and after versions count separately.
All unique captured source in the prepared bundles matched the exact recorded
Git objects. Original packets, source measurements, and model probes were read
as frozen evidence rather than regenerated.

The replay uses deliberately synthetic complete reports to check aggregation:
all matching parts satisfy the structural gate, removing one required report
returns incomplete, and a projected partition cannot pass independently. These
probes contain no model reasoning and establish no semantic review or approval.
The gate regression suite separately exercises missing/stale/duplicate reports,
cross-part evidence misuse, conflicting findings and reconciliations, and
preservation of prior blockers across incomplete persisted runs.

Shared context repeats across packets. PR 508 has 3,014,721 unique source bytes
and 5,288,915 cumulative packet source bytes. The two PR 513 revisions each have
approximately 3.3 million unique source bytes and 6.9 million cumulative packet
source bytes. These are source-byte measurements, not prompt token counts or
cost estimates. Actual provider input limits, latency, and cost remain unverified.

`replayPartitionBundles.ts` is a local, read-only historical-source diagnostic.
It prepares ignored source artifacts and synthetic reports in a new
digest-keyed directory, checks captured source and membership, and refuses to
overwrite a previous run. It performs no model call, ledger write, or GitHub
action. Use the captured `partition-results.json` to report these results,
instead of rerunning their derivation.

The static graph still cannot prove complete runtime impact. Missing required
runtime wiring or cross-part evidence must be reported incomplete by the
reviewer. A dependency closure too large for one packet, total source-byte
overflow, and other collector limitations still prevent preparation.

## Limits And Reproduction

`probeHistorical.ts` is an explicit, paid, local model command. It consumes
previously captured source files under `.artifacts/` and refuses to overwrite
existing request/response files. Do not run it merely to render or summarize
captured results. Raw artifacts are intentionally not bundled into a release.

The local CLI reported first-party access and emitted an unrecognized-model
warning. This does not verify the production Bedrock service account, routing,
or exact deployed model. There is no calibrated precision/recall estimate,
held-out benchmark, complete historical PR model review, or production rollout
claim.

Before mandatory use: verify the deployed provider/model, finish whole-PR
replays with caller context, independently label defective and acceptable
cases, evaluate multi-round reconciliation, and run a human-adjudicated shadow
period. Policy release and Sentinel adoption remain explicit human decisions.
