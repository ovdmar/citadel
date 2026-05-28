// Canonical statement of Citadel's non-fast-forward push policy. Imported by
// any prompt body or doc that needs to restate the rule, so we change the
// language in exactly one place if the policy ever shifts.
export const CITADEL_NON_FF_POLICY =
  "The repo policy is explicit: pull main with merge, never rebase, never force-push.";
