# Sentinel Review System — Design and Implementation Review

**Review date:** 2026-10-31  
**Method:** Static source review; no tests, scripts, model calls, or network calls were run, and no implementation files were changed. This document was subsequently created at the user's request.  
**Scope:** Repository documentation, implementation, trusted policy/prompts, relevant tests, and frozen evaluation evidence.  
**Version caveat:** This review describes the source inspected during the review session. A Git commit SHA was not captured. Line references describe that source state and may drift after changes.  
**Status:** Findings have not been fixed or runtime-reproduced as part of this review.

## Executive assessment

**Keep this in shadow mode.** The POC has meaningful fail-closed controls, but it is not ready to serve as a required merge check.

The strongest concrete issues are:

1. Git attributes can bypass the cumulative changed-line limit.
2. Replaying an old successful run can return `pass` after a newer review found a blocker.
3. Reordering valid journal entries can restore an older clean ledger.
4. Context collection can silently omit dependencies before partition validation sees them.

These findings distinguish three categories:

- **Deterministic implementation bugs:** Observable inconsistencies or bypasses in the implemented machinery.
- **POC design limitations:** Attestations and static-analysis limits that schema validation cannot turn into semantic guarantees.
- **Production blockers:** Missing trust, evaluation, durability, and operational capabilities required before merge gating.

## Finding index

| ID | Severity | Finding |
| --- | --- | --- |
| [DG-01](#dg-01--high--git-binary-classification-bypasses-the-size-stop) | High | Git binary classification bypasses the size stop |
| [DG-02](#dg-02--high--historical-replay-returns-a-stale-pass) | High | Historical replay returns a stale pass |
| [DG-03](#dg-03--high--journal-reordering-can-resurrect-an-old-ledger) | High | Journal reordering can resurrect an old ledger |
| [DG-04](#dg-04--medium--policy-context-forward-dependencies-are-omitted) | Medium | Policy-context forward dependencies are omitted |
| [DG-05](#dg-05--medium--unsupported-importers-are-silently-excluded) | Medium | Unsupported importers are silently excluded |
| [DG-06](#dg-06--medium--cache-only-state-can-authorize-writes) | Medium | Cache-only state can authorize writes |
| [DG-07](#dg-07--medium--failed-repair-reservation-corrupts-accounting) | Medium | Failed repair reservation corrupts accounting |
| [DG-08](#dg-08--medium--nested-reports-lack-partition-specific-binding) | Medium | Nested reports lack partition-specific binding |
| [DG-09](#dg-09--medium--synthetic-provenance-is-lost-before-recording) | Medium | Synthetic provenance is lost before recording |
| [PB-01](#pb-01--blocker--authenticated-current-pr-to-execution-chain) | Blocker | Authenticated current-PR-to-execution chain |
| [PB-02](#pb-02--blocker--whole-pr-model-quality-evaluation) | Blocker | Whole-PR model quality evaluation |
| [PB-03](#pb-03--high--durable-ordered-state-and-recovery) | High | Durable ordered state and recovery |
| [PB-04](#pb-04--high--human-adjudication-and-operational-controls) | High | Human adjudication and operational controls |

## A. Deterministic gate and implementation bugs

### DG-01 — High — Git binary classification bypasses the size stop

**Evidence:** [snapshot.ts:120–141](<../src/snapshot.ts#L120-L141>), [snapshot.ts:383–399](<../src/snapshot.ts#L383-L399>), [snapshot.ts:510–551](<../src/snapshot.ts#L510-L551>).

`countChangedLines` skips every `-/-` numstat record. Later, source collection independently considers a blob binary only if it contains a NUL byte.

**Failure scenario:** A repository attribute such as `*.ts -diff` makes Git classify a large textual TypeScript change as binary. Numstat contributes zero lines, while the collector accepts its NUL-free source. A change exceeding 1,500 lines can therefore produce a complete, under-threshold snapshot, provided it remains within the byte limits.

This also makes collection sensitive to Git attributes/configuration beyond the captured commit contents.

**Suggested fix:** Compute eligible text changes independently of repository-controlled binary classification, or refuse preparation when a changed source has unavailable numeric counts. Make the Git configuration/attribute environment deterministic.

**Test gap:** [snapshot.test.ts:105–148](<../tests/snapshot.test.ts#L105-L148>) covers ordinary text thresholds and renames, not attribute-classified textual changes.

### DG-02 — High — Historical replay returns a stale pass

**Evidence:** [state.ts:364–374](<../src/state.ts#L364-L374>), [cli.ts:228–235](<../src/cli.ts#L228-L235>).

The identical-run replay branch returns the original decision before evaluating it against current ledger state. The CLI translates that historical decision directly into exit code zero.

**Failure scenario:**

1. Run R1 passes head H.
2. Run R2 reviews the same H and records a blocker.
3. The operator submits R1's exact snapshot and report again.
4. `record` returns R1's `pass`, although the current ledger still contains R2's blocker.

**Boundary:** This does not erase the blocker. It exposes an obsolete success as a current command result, which can mislead a future CI integration.

**Suggested fix:** Separate historical replay acknowledgement from current merge eligibility. Return the historical decision as historical data, but refuse to emit current success when its state revision is superseded. Introduce a monotonic ledger revision/digest rather than using head SHA alone.

**Test gap:** [state.test.ts:59–71](<../tests/state.test.ts#L59-L71>) only replays immediately, without intervening state.

### DG-03 — High — Journal reordering can resurrect an old ledger

**Evidence:** [state.ts:223–246](<../src/state.ts#L223-L246>), [state.ts:255–263](<../src/state.ts#L255-L263>).

Journal validation checks uniqueness, matching run records, timestamps, and ledger equality. It does not validate entry ordering or transitions. The final journal entry becomes authoritative.

**Failure scenario:** Following a clean R1 and blocking R2, swap their two otherwise-valid journal lines. Both still match immutable records; validation succeeds; R1's clean ledger becomes current. A subsequent run can proceed without R2's finding.

**Boundary:** This requires local state corruption or editing, not merely malicious report JSON. It nevertheless contradicts the claimed fail-closed consistency boundary.

**Suggested fix:** Persist and validate monotonic sequence numbers plus previous-state/run commitments. Validate transitions, including same-head reviews; timestamps alone are insufficient.

**Test gap:** [state.test.ts:239–252](<../tests/state.test.ts#L239-L252>) rejects a duplicated journal entry but does not exercise reordered unique entries.

### DG-04 — Medium — Policy-context forward dependencies are omitted

**Evidence:** [snapshot.ts:427–453](<../src/snapshot.ts#L427-L453>), [contextPlanner.ts:769–824](<../src/contextPlanner.ts#L769-L824>), [partitionContract.ts:45–55](<../src/partitionContract.ts#L45-L55>).

The planner seeds changed paths and prior-finding paths. Policy-context files are added afterward. The planner has already discarded edges whose endpoints were not selected.

**Failure scenario:** The configured Playwright configuration imports an otherwise-unselected local setup/configuration module. On an unrelated PR, the configuration is included as shared base context, but its imported module and edge are absent. Manifest validation sees no edge to close and accepts the bundle.

**Suggested fix:** Include policy roots in revision-aware forward planning before filtering the graph. Validate closure against the authoritative graph, not a graph that has already omitted unselected dependencies.

**Test gap:** [partitionPlanner.test.ts:270–282](<../tests/partitionPlanner.test.ts#L270-L282>) checks inclusion of policy files, not their transitive dependencies.

### DG-05 — Medium — Unsupported importers are silently excluded

**Evidence:** [snapshot.ts:10–14](<../src/snapshot.ts#L10-L14>), [snapshot.ts:299–339](<../src/snapshot.ts#L299-L339>).

The graph inventory includes only TypeScript-family extensions and excludes every path containing a dot-prefixed segment. Excluded consumers generate neither fallback evidence nor limitations.

**Failure scenario:** A changed TypeScript export has an unchanged JavaScript consumer, or a consumer in a tracked hidden source directory. The consumer never enters graph construction; reverse tracing misses it; the packet can remain complete. Likewise, a selected JavaScript dependency can be captured without its own imports being traversed.

**Suggested fix:** Support relevant JS/JSX and repository source directories, or explicitly mark unsupported impact coverage incomplete. Document and validate an analysis scope instead of silently assuming excluded code is irrelevant.

**Boundary:** This differs from an acknowledged inability to prove arbitrary runtime semantics: these are ordinary source/import relationships excluded before analysis.

### DG-06 — Medium — Cache-only state can authorize writes

**Evidence:** [state.ts:255–285](<../src/state.ts#L255-L285>), [state.ts:356–363](<../src/state.ts#L356-L363>).

When no journal or runs exist, a valid ledger cache is adopted as authoritative. The missing-journal write guard only triggers when immutable runs remain.

**Failure scenario:** History is lost or incompletely restored, leaving a stale but valid clean cache. The next review can record against it without recovering missing findings.

**Suggested fix:** Only initialize fresh state when all history/cache artifacts are absent. A cache without authoritative history should require recovery, not authorize writes.

**Test gap:** Existing tests cover corrupt cache and missing journal with surviving runs, but not valid cache-only state: [state.test.ts:216–222](<../tests/state.test.ts#L216-L222>), [state.test.ts:277–291](<../tests/state.test.ts#L277-L291>).

### DG-07 — Medium — Failed repair reservation corrupts accounting

**Evidence:** [reviewRunner.ts:366–382](<../src/reviewRunner.ts#L366-L382>), [reviewRunner.ts:418–427](<../src/reviewRunner.ts#L418-L427>), [reviewRunner.ts:201–209](<../src/reviewRunner.ts#L201-L209>).

The repair code assigns `reserved` before `budget.reserve` succeeds. If reservation fails, its catch block still attempts to settle that amount against the aggregate reserved balance.

**Failure scenario:** Another initial call holds 10 microdollars. A repair needs 5, but the cap permits only 4 more. Reservation fails; the catch charges 5 against the other call's reservation. Releasing that other call's full reservation then fails and is silently swallowed.

The result is phantom spend and stranded reservations, not demonstrated actual provider overspending. No repair invocation occurred.

**Suggested fix:** Track reservation ownership and whether invocation started separately. Use reservation handles; settle only acquired reservations. Count/fit/reserve failures must release at zero, without uncertain invocation charges.

**Test gap:** [reviewBudget.test.ts:67–75](<../tests/reviewBudget.test.ts#L67-L75>) tests the budget primitive, not this runner failure path.

### DG-08 — Medium — Nested reports lack partition-specific binding

**Evidence:** [contracts.ts:7–16](<../src/contracts.ts#L7-L16>), [contracts.ts:119–127](<../src/contracts.ts#L119-L127>), [partitionGate.ts:51–65](<../src/partitionGate.ts#L51-L65>), [gate.ts:250–267](<../src/gate.ts#L250-L267>).

A nested report contains only the parent identity. Its envelope row supplies the partition ID; the report itself contains no manifest/request commitment.

**Failure scenario:** Two parts contain the same changed code and direct callers but differ in transitive callers. A clean report mentioning only the common direct neighbors can be copied into both rows. Both pass because unchanged transitive source entries have no individual coverage requirement.

**Suggested fix:** Bind each report to partition ID, manifest digest, and request/source-set digest. Require explicit coverage of assigned context roots, not just changed-file dimensions.

**Boundary:** This is a deterministic misassociation gap, not proof of model execution. Preventing deliberate fabrication additionally requires trusted execution provenance. A public digest alone is not authentication.

### DG-09 — Medium — Synthetic provenance is lost before recording

**Evidence:** [reviewRunner.ts:162–167](<../src/reviewRunner.ts#L162-L167>), [reviewRunner.ts:309–320](<../src/reviewRunner.ts#L309-L320>), [cli.ts:224–231](<../src/cli.ts#L224-L231>).

Mock output uses the same accepted report envelope as real output. Its synthetic designation is in execution metadata and the filename, neither of which `record` verifies.

**Failure scenario:** A clean mock result is supplied directly to `record`; it can advance the ledger and return pass. No relabeling or envelope modification is necessary.

There is a related labeling defect: [mockProvider.ts:27–51](<../src/mockProvider.ts#L27-L51>) does not require the fixture's provider discriminator to be `mock`. A fixture claiming Bedrock can produce `synthetic:false` artifacts through the mock CLI path, although execution is correctly blocked and remains incomplete.

**Suggested fix:** Carry execution provenance through the recording boundary; reject synthetic runs for operational state. Derive adapter identity from trusted construction, not fixture configuration. A marker prevents accidents; authenticated provenance is needed against intentional forgery.

**Test gap:** [reviewCli.test.ts:71–83](<../tests/reviewCli.test.ts#L71-L83>) verifies ordinary mock labels/filenames but not submission of that output to `record` or a cross-provider fixture.

## B. Design limitations acceptable for a POC

### DL-01 — Coverage and citations can still certify a shallow review

The schema enforces presence and consistency, not substantive analysis:

- Coverage rationales need only be nonempty.
- A report can enumerate required neighbors without reading them.
- Exact quotes prove that text exists, not that it supports the claim.
- Attribution requires a changed path, not an introduced defect or changed hunk.
- Findings can have empty counterevidence.
- Reconciliation can close a blocker using any valid captured quote.

See [gate.ts:67–95](<../src/gate.ts#L67-L95>), [gate.ts:241–305](<../src/gate.ts#L241-L305>).

**Noteworthy test:** [gate.test.ts:244–255](<../tests/gate.test.ts#L244-L255>) expects a blocker to be fixed while quoting the same offending `required = false` line. That is valid as a test of the current structural contract, but wrong evidence for a claim that resolution is semantically verified. Similarly, agreement across partitions does not make an unsupported withdrawal true.

Do not fix this by universally requiring changed evidence: a legitimate withdrawal may correct an earlier false positive without code changes. Instead, distinguish model attestation from independently adjudicated resolution.

### DL-02 — Context-window behavior is safe but operationally unresolved

The 200-entry and 4 MB limits do not establish model fit. Every part repeats shared source, the full cumulative diff, optional delta, policy/contract text, and prior ledger; line numbering adds overhead.

The runner correctly counts the fully rendered request, adds reserved output, and checks every initial request before invoking any: [reviewRunner.ts:44–81](<../src/reviewRunner.ts#L44-L81>), [reviewRunner.ts:181–199](<../src/reviewRunner.ts#L181-L199>), [reviewBudget.ts:72–75](<../src/reviewBudget.ts#L72-L75>).

An oversized request therefore fails closed rather than silently truncating. That is adequate for safety, not availability:

- There is no token-aware repartitioning.
- If shared context alone exceeds the window, adding partitions cannot help.
- Prior findings have no practical growth bound.
- There is no semantic decomposition fallback.

Frozen measurements already show approximately 5.29 MB cumulative packet source for PR 508 and 6.93 MB for PR 513 before JSON/numbering/prompt overhead: [partition-results.json:29–60](<../evaluations/partition-results.json#L29-L60>). These are not verified token counts.

**Recommended direction:** Plan against measured token budgets with output/repair headroom, expose shared-context cost separately, and refuse irreducible scopes with actionable diagnostics rather than silently reducing evidence.

### DL-03 — Partition closure is not global behavioral reasoning

The implementation is sorted next-fit packing, not first-fit: it fills the current packet, flushes, and does not revisit earlier packets. See [partitionPlanner.ts:48–64](<../src/partitionPlanner.ts#L48-L64>).

For represented edges, each assigned root retains forward closure and the manifest checks membership/closure. No silent cross-part edge loss was identified at that layer.

However, sibling callers interacting through shared state, fixture composition, runtime registration, or external systems may never be jointly reviewed. Aggregation merges findings; it does not perform a final semantic cross-part review.

Accept this as a POC boundary, or add explicit integration-risk review units and bounded escalation. Closure checks cannot compensate for omitted graph edges described in DG-04 and DG-05.

### DL-04 — Size/scope behavior otherwise matches the stated policy

Cumulative review is merge-base-to-head; the previous-head diff is only a navigation aid. Force-push ancestry is disclosed. Thresholds use `>` correctly; pure renames count zero; there is no PR file-count size rule.

The 200-entry cap is a packet resource limit, though shared changed source exceeding that cap can still stop preparation independently of changed-line count.

One documentation overclaim remains: record-time size validation checks supplied values and threshold consistency, not their truth against Git: [snapshot.ts:614–625](<../src/snapshot.ts#L614-L625>). The claim that forged size assessments are rejected should be narrowed unless collector authenticity or recomputation is added.

This belongs to the documented trusted-local-snapshot boundary, not a separate untrusted-report bypass. An attacker allowed to rewrite an unauthenticated snapshot can rewrite far more than its size assessment.

## C. Production blockers

### PB-01 — Blocker — Authenticated current-PR-to-execution chain

SHA equality and public hashes establish consistency, not authenticity. The documented trusted-local-snapshot boundary is reasonable for this POC, but insufficient for the stated production goal.

Before merge gating, require:

- Trusted collection of repository, PR head, target base, merge base, and current policy.
- A pinned reviewer release outside the reviewed checkout.
- Execution provenance binding request, response, manifest, provider, and prior-ledger revision.
- Revalidation of current head/base/policy/state immediately before publishing success.
- A designated required-check publisher that cannot be impersonated by PR-controlled workflows.

The current ledger stores only `lastHeadSha`, not a complete state/review identity: [contracts.ts:129–135](<../src/contracts.ts#L129-L135>).

### PB-02 — Blocker — Whole-PR model quality evaluation

Require held-out, human-labeled defective and acceptable cases; whole-PR reviews; multi-round finding survival/resolution; prompt-injection cases; and measured false-negative/false-positive rates, incomplete rates, latency, and cost.

**Evidence distinction:** The repository contains frozen evidence describing prior bounded model probes, not only no-model replays. [historical-results.json:7–60](<../evaluations/historical-results.json#L7-L60>) records those probes and failed citation validation. The partition replay separately records no model execution. Neither establishes complete-PR accuracy. No new calls were made for this review.

### PB-03 — High — Durable ordered state and recovery

Local exclusive locks and immutable run files are useful, but not distributed durability. State writes lack a transactional/fsync durability protocol; caches can recover incorrectly as described in DG-06.

Production needs conditional writes/CAS, monotonic event ordering, durable history, backups, recovery drills, event reconciliation, and explicit handling of uncertain provider execution. A fresh output directory does not prevent repeated paid runs under new directories.

**Suggested approach:** Treat recording and publishing as separate durable transitions, each bound to a state revision. Retain immutable evidence while preventing historical results from becoming current accidentally.

### PB-04 — High — Human adjudication and operational controls

Before requiring the check, provide:

- Stable finding/thread identity and author challenge history.
- Authorized, audited resolution/waiver decisions with scope and expiry.
- Metrics for dropped findings, incomplete context, repair failures, spend uncertainty, and stale events.
- A rollback/kill switch and explicit release/policy migration behavior.
- Two human approvals enforced independently of automated success.

Retrospective preparation correctly remains draft-only with empty candidates; it is not a substitute for this lifecycle: [retrospective.ts:90–111](<../src/retrospective.ts#L90-L111>).

## D. Security, provider, and code-quality notes

### Controls worth retaining

- Strict duplicate-key rejection.
- Exact source-line evidence validation.
- Complete-manifest checks and rejection of independent partition passes.
- Protected citation-only repair with a bounded attempt count.
- Integer/BigInt cost arithmetic and pre-invocation reservations.
- Explicit execution consent and sequential invocation.
- Disabled AWS retries, text-only replies, and terminal non-`end_turn` handling.
- Private runner root/files.
- No execution of reviewed source.
- Exclusive per-PR locks, immutable run creation, and no automatic stale-lock breaking.

### Remaining security and robustness boundaries

- **Prompt injection:** Addressed through instructions, not an enforceable semantic barrier.
- **Secrets:** Secret-like path filtering is not content secret detection.
- **Provider environment:** AWS credentials, executable resolution, profiles, and account routing remain operator-environment trust. Pricing/counting are attestations, not account-level spend enforcement.
- **Analysis resources:** Graph construction reads the full TS inventory before packet byte limits apply: [snapshot.ts:311–329](<../src/snapshot.ts#L311-L329>). Large repositories can exhaust analysis resources despite a small final packet. Use a separate bounded analysis budget or streaming/cache strategy.
- **State permissions:** State files use default creation permissions, unlike runner artifacts: [state.ts:315–329](<../src/state.ts#L315-L329>). Harden these for shared hosts.
- **Binary renames:** Numstat handling skips binary rows before advancing rename path fields, causing an operational failure rather than the intended binary limitation: [snapshot.ts:129–139](<../src/snapshot.ts#L129-L139>). This is fail-closed availability, not a pass bypass.
- **Untrusted input volume:** Strict JSON depth checks are not input-byte limits. Consider explicit report/fixture/state size bounds before parsing or writing large untrusted inputs.

### Code-quality assessment

The highest-value refactoring is to centralize validated identities, snapshot/state revisions, reservation ownership, and provenance. Currently, validation strength depends on which entry point is called, and several modules duplicate schema/canonicalization logic.

The context planner contains substantial custom semantic analysis. Preserve its conservative fallback behavior, but make supported syntax/source scope explicit and test the boundaries where inputs never enter the model. Improving packing efficiency should not obscure closure correctness.

### Tests and claimed invariants

Some tests assert less than their names imply:

- The resolution test in [gate.test.ts:244–255](<../tests/gate.test.ts#L244-L255>) demonstrates structural acceptance, not semantic evidence of a fix.
- The “immutable file reference” assertion merely checks a `file://` prefix in [bedrockProvider.test.ts:62](<../tests/bedrockProvider.test.ts#L62>); the adapter writes payloads with ordinary overwriting writes.
- Tampered-size tests cover oversized/inconsistent declarations, not downward falsification.
- Immediate replay tests do not establish safety after intervening reviews.
- Journal duplication tests do not establish ordering integrity.
- Mock labeling tests do not establish rejection at the recording boundary.
- Primitive budget tests do not establish reservation ownership through the repair error path.

These are coverage gaps, not reasons to discard the substantial existing regression suite. Passing deterministic tests does not establish model accuracy.

## Recommended remediation order

1. **Fix DG-01 and DG-02:** deterministic size enforcement and prevention of stale success publication.
2. **Fix DG-03 and DG-06:** ordered authoritative state and fail-closed recovery.
3. **Fix DG-04 and DG-05:** complete context-root collection and explicit unsupported-source handling.
4. **Fix DG-07:** reservation ownership and accurate failure accounting.
5. **Fix DG-08 and DG-09:** partition association and execution provenance through recording.
6. **Resolve production blockers:** trusted hosted lifecycle, realistic token-fit evaluation, durable state, and human-adjudicated shadow calibration.
7. **Only then consider a required check**, retaining two independent human approvals and an explicit rollback path.
