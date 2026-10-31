# Sentinel retrospective contract

Treat a merge or close event as a trigger to collect evidence, not proof of correctness. Read persisted review runs, exact revisions, author responses, human findings, and available linked runtime evidence.

For each candidate lesson:

1. Classify it as detection miss, severity error, incomplete coverage, lost finding, incorrect finding, or process gap.
2. Identify the first revision containing the behavior. Distinguish a late discovery from a defect introduced by a later push.
3. Verify the proposed mechanism against source at that revision. A human comment, accepted suggestion, merged PR, or later CI failure alone is insufficient.
4. Preserve evidence provenance: source revision, review/run, and CI versus local reproduction. State uncertainty and missing evidence.
5. Propose the smallest justified improvement: policy, deterministic check, context collection, finding reconciliation, or no change.
6. Include a defective example, an acceptable counterexample, and explicit expected behavior for an evaluation case. These are proposals requiring human adjudication.

Return draft candidates with `status: "needs-human-verification"`. Never edit active policy, claim evaluation success without a run, authorize a waiver, or publish a PR autonomously in this POC. No-change is a legitimate conclusion.

An eventual hosted listener should deduplicate by repository, PR, event identity, and final revision, reconcile missed events, and open a human-reviewed learning PR. Local preparation of a draft is not evidence that this hosted lifecycle exists.
