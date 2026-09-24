# evidence/

Real output from real runs against a live target-app, not fabricated for the
write-up. Each `replay/` and `discovery/` folder is one run, written by
`automation/evidence.ts`; the two other directories are earlier, one-off
verification passes (raw `ariaSnapshot()` captures, not run output). Every
run folder has a `summary.json` (human-readable), a `steps.jsonl` (one
record per step or turn), and, where the run didn't end cleanly or paused
for a human, one or more `*.raw-page-content.png` screenshots.

## replay/

- **`2026-09-23T23-33-04-658Z-lookup_member_savings_balance`**: plain
  success. Logs in, searches, reads a member's name and savings balance,
  no recoveries fired.
- **`2026-09-23T23-33-06-496Z-lookup_member_savings_balance`**: business
  outcome, not a failure. Same capability, a member id that doesn't exist;
  ends `business_outcome: member_not_found`, never thrown, never logged as
  an error. Cited in REPORT.md and README.md as the example of the
  business-outcome/failure distinction.
- **`2026-09-23T23-46-21-700Z-discovered_lookup_member_savings_balance`**:
  the round-trip proof. Replays `discovered_lookup_member_savings_balance`,
  the artifact `discover()` produced on its own (see `discovery/2026-09-23T23-46-19-809Z`
  below), through the same, unmodified `replay()` the hand-authored
  capability uses. Succeeds end to end: the strongest available evidence
  that discovery and replay agree on one artifact format, not just that
  discovery *looks* right.
- **`2026-09-24T09-17-25-079Z-open_member_sub_account`**: the irreversible
  step stopping on its own. No `onEscalation` handler configured at all
  (`"interventions": []`); replay reaches the classified-`irreversible`
  confirm step and ends `escalated` before attempting it, rather than
  guessing or retrying.
- **`2026-09-24T14-26-24-983Z-open_member_sub_account`**: the escalation
  handoff, live, end to end. Same capability, run with `--interactive`; a
  human completed the confirm step in the same live browser window
  automation had paused, answered `performed`, and replay verified the
  page before completing with `success`. The confirm step's own line in
  `summary.json` shows `handledByOperator: true, operatorSignal: "performed"`
  directly. Cited in REPORT.md and README.md as the live proof of the
  control-transfer mechanism.

## discovery/

- **`2026-09-23T23-46-19-809Z`**: the happy path. `discover()` reaches
  `done` in 9 turns for the same goal the hand-authored capability solves
  (login, search, read name and balance), producing
  `discovered_lookup_member_savings_balance` (replayed successfully above).
- **`2026-09-24T04-14-09-515Z`**: the safety half of the discovery story.
  Goal was to open a sub-account; the model reached the irreversible
  "Open Sub-Account" control, the policy gate refused to execute it, and
  the model escalated with `reasonCode=action_refused_irreversible`. The
  only evidence that discovery's irreversible-control refusal actually
  fires against a real model, not just in a scripted test. This run
  predates the app-profile correction described in REPORT.md's Safety
  section, so it names the control that was later found to be plain
  navigation, not the actual irreversible action.

## accessibility-snapshot-spike/

Not a run. The earliest live check of what Playwright's `ariaSnapshot()`
actually reports for target-app's login, search, member-detail, and
balance-panel pages, including the two findings that changed the design:
nested layout tables aren't distinguishable from data tables by role alone,
and an iframe's `title` attribute doesn't surface as its accessible name.
See `findings.md`.

## app-profile-verification/

Not a run either. Live captures backing every outcome, recovery, and
irreversible-control declaration in
`capabilities/fake-credit-union-console.app-profile.json`, one fresh login
per condition. Includes the correction where an earlier pass had declared
the wrong control irreversible (`open-member-sub-account-flow.aria.yaml`
and `findings.md`'s correction section). See `findings.md`.
