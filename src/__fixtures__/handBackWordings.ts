// One notice of each wording a release shipped for a notice that hands work
// back, from before the hidden hand-back line (src/loop/markers.ts). The
// Standing (src/kit/standingHandBacks.ts) still reads each of them as the same
// hand-back as its marked successor, the kind of failure aside, which no old
// wording gives. Each is spelled as that release's code wrote it, with a
// Ticket #7, its agent PR #50, a Decision #12 and the Operator `operator`.
import type { HandBack } from "../loop/handBacks.ts";
import type { AgentRole } from "../loop/types.ts";

/** A notice from before the hidden line, the release that first wrote it so, and what its marked successor names, but the failure. */
export interface PastHandBackNotice {
  /** The first release that wrote this wording. */
  readonly release: string;
  readonly handBack: HandBack;
  readonly role?: AgentRole;
  readonly body: string;
}

const RUN = "https://github.com/owner/product/actions/runs/42/attempts/1";
const MAIN = "d".repeat(40);

export const PAST_HAND_BACK_NOTICES: readonly PastHandBackNotice[] = [
  // The failure notice, with no marker: every role's, until v0.6.0 marked a Design-session turn's and a Research run's.
  {
    release: "v0.1.0",
    handBack: "infrastructure-failure",
    role: "implement",
    body: [
      "@operator The Implement run on #7 failed: it crashed.",
      "",
      "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Re-add the `agent:implement` label to run it again.",
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  {
    release: "v0.1.0",
    handBack: "infrastructure-failure",
    role: "review",
    body: [
      "@operator The Review run on #7 failed: the Reviewer gave no valid Verdict.",
      "",
      "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Re-add the `agent:review` label to run it again.",
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  {
    release: "v0.1.0",
    handBack: "infrastructure-failure",
    role: "triage",
    body: [
      "The Triage run on #7 failed: it hit the weekly usage limit.",
      "",
      "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Re-add the `needs-triage` label to run it again.",
      "",
      "See #20, where the Kit tracks the weekly limit.",
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  {
    release: "v0.1.0",
    handBack: "design-turn-failed",
    role: "design",
    body: [
      "@operator The Design-session turn run on #7 failed: it crashed.",
      "",
      "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Reply on this issue to run the turn again.",
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  // v0.6.0 marked a Design-session turn's and a Research run's failure, and named a prototype turn.
  {
    release: "v0.6.0",
    handBack: "design-turn-failed",
    role: "design",
    body: [
      "<!-- fabrik:design-turn-failed -->",
      "@operator The prototype turn on #7 failed: it crashed.",
      "",
      "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Reply on this issue to carry the session on: the turn your reply starts can ask for the prototype again.",
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  {
    release: "v0.6.0",
    handBack: "research-failed",
    role: "research",
    body: [
      "<!-- fabrik:research-run-failed -->",
      "@operator The Research run on #12 failed: it crashed.",
      "",
      "This is an Infrastructure failure, so neither the Loop nor Dispatch runs it again by itself. Re-add the `agent:research` label to run it again.",
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  // v1.0.0: a conflict-only run and a Request-changes run that didn't land, and one that committed nothing.
  {
    release: "v1.0.0",
    handBack: "conflict-run-unlanded",
    role: "implement",
    body: [
      "<!-- fabrik:conflict-run-ended -->",
      `@operator The conflict-only run on #50 didn't bring it up to date with \`main\` at ${MAIN.slice(0, 7)}: it changed nothing.`,
      "",
      `The PR still conflicts with \`main\`, so it's yours to resolve: the Kit won't try again until \`main\` moves past ${MAIN.slice(0, 7)}. No retry was used.`,
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  {
    release: "v1.0.0",
    handBack: "request-changes-unlanded",
    role: "implement",
    body: [
      `<!-- fabrik:request-changes-run-ended ${MAIN} -->`,
      "@operator The Request-changes run on #50 didn't land: what it built still conflicts with `main`.",
      "",
      `The Kit judged the run against \`main\` at ${MAIN.slice(0, 7)}, and your requested changes aren't built, so it's yours from here. The Kit won't bring it up to date until \`main\` moves past ${MAIN.slice(0, 7)}; when it does, your Request changes still goes first. No retry was used.`,
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  {
    release: "v1.0.0",
    handBack: "request-changes-empty",
    role: "implement",
    body: [
      "<!-- fabrik:request-changes-run-empty -->",
      "@operator The Request-changes run on #50 committed nothing to `fabrik/ticket-7` on top of aaaaaaa, so your requested changes aren't built, and it's yours from here. No retry was used.",
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  // v1.0.1: a Retry that never started on a Ticket no longer ready-for-agent.
  {
    release: "v1.0.1",
    handBack: "retry-never-started",
    role: "implement",
    body: [
      "<!-- fabrik:retry-ended -->",
      "@operator Retry 1 of 2 on #50 never started. #7 is no longer `ready-for-agent`, so no Retry starts. #50 stays in draft: push to it to have it reviewed again, or take it out of draft to take it over.",
    ].join("\n"),
  },
  // v2.0.0 marked a failed Implement run, and added a PR closed by hand, the stuck-trigger sweep's give-up and a failed landing.
  {
    release: "v2.0.0",
    handBack: "infrastructure-failure",
    role: "implement",
    body: [
      "<!-- fabrik:implement-run-failed -->",
      "@operator The Implement run on #7 failed: it was cancelled, by its 60-minute timeout or by hand.",
      "",
      "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Re-add the `agent:implement` label to run it again.",
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  {
    release: "v2.0.0",
    handBack: "closed-by-hand",
    role: "implement",
    body: "#50 was closed unmerged by hand, so the Kit won't start another Implement run on this Ticket by itself, and its branch `fabrik/ticket-7` stays. To have an Implementer try again, mark it `ready-for-agent`: the new run starts from `main` and replaces that branch.",
  },
  {
    release: "v2.0.0",
    handBack: "trigger-swept",
    role: "implement",
    body: [
      "<!-- fabrik:implement-run-failed -->",
      "<!-- fabrik:stuck-trigger-gave-up agent:implement -->",
      "@operator `agent:implement` came off: nothing started when it was added, nor when the Kit added it again. Check the Loop's Actions runs (an invalid Kit config is the usual cause), then add `agent:implement` again once it's fixed.",
    ].join("\n"),
  },
  {
    release: "v2.0.0",
    handBack: "trigger-swept",
    role: "review",
    body: [
      "<!-- fabrik:stuck-trigger-gave-up agent:review -->",
      "@operator `agent:review` came off: nothing started when it was added, nor when the Kit added it again. Check the Loop's Actions runs (an invalid Kit config is the usual cause), then add `agent:review` again once it's fixed.",
    ].join("\n"),
  },
  {
    release: "v2.0.0",
    handBack: "landing-failed",
    role: "implement",
    body: [
      `@operator **The Kit couldn't land the Implement run on #7.** The [push job](${RUN}) failed.`,
      "**What failed:** GitHub failed `POST /repos/owner/product/pulls` with a 502, its own failure rather than the Kit's: Bad Gateway",
      "**To recover:** The agent's finished work waits in this run's `fabrik-agent-result` artifact, which Actions keeps for 7 days. Open the run and choose **Re-run jobs → Re-run failed jobs** before then to land it.",
    ].join("\n\n"),
  },
  {
    release: "v2.0.0",
    handBack: "landing-failed",
    body: [
      `@operator **The Kit couldn't land the claim of #7, taking its trigger label off as its run starts.** The [claim job](${RUN}) failed.`,
      "**What failed:** GitHub never answered `DELETE /repos/owner/product/issues/7/labels/agent%3Aimplement`: socket hang up",
      "**To recover:** Open the run and choose **Re-run jobs → Re-run failed jobs** to try it again.",
    ].join("\n\n"),
  },
  // v2.1.0 named the label's home in the resume, and a Triage run's failure stopped counting a Ticket's retries.
  {
    release: "v2.1.0",
    handBack: "infrastructure-failure",
    role: "review",
    body: [
      "@operator The Review run on #7 failed: the Reviewer gave no valid Verdict.",
      "",
      "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Re-add `agent:review` on this PR to run it again.",
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  {
    release: "v2.1.0",
    handBack: "infrastructure-failure",
    role: "triage",
    body: [
      "@operator The Triage run on #7 failed: it crashed.",
      "",
      "This is an Infrastructure failure, so the Loop won't retry it. Re-add `needs-triage` on this issue to run it again.",
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  // v2.2.0: a Kept branch gone, and a failed landing of a first Implement run marked as its failed run.
  {
    release: "v2.2.0",
    handBack: "kept-branch-gone",
    role: "implement",
    body: "This Ticket is marked `fabrik:kept-branch`, but its Kept branch `fabrik/ticket-7` is gone, so the Kit started no Implement run on it. Take `fabrik:kept-branch` off and mark it `ready-for-agent` again to start it from `main`, or push `fabrik/ticket-7` back first to carry on from it.",
  },
  {
    release: "v2.2.0",
    handBack: "landing-failed",
    role: "implement",
    body: [
      `<!-- fabrik:implement-run-failed -->\n@operator **The Kit couldn't land the Implement run on #7.** The [push job](${RUN}) failed.`,
      "**What failed:** The Kit failed: boom",
      "**To recover:** The agent's finished work waits in this run's `fabrik-agent-result` artifact, which Actions keeps for 7 days. Open the run and choose **Re-run jobs → Re-run failed jobs** before then to land it.",
    ].join("\n\n"),
  },
  {
    release: "v2.2.0",
    handBack: "landing-failed",
    role: "review",
    body: [
      `@operator **The Kit couldn't land the Review of #50.** The [push job](${RUN}) failed.`,
      "**What failed:** The Kit failed: boom",
      "**To recover:** The agent's finished work waits in this run's `fabrik-agent-result` artifact, which Actions keeps for 7 days. Open the run and choose **Re-run jobs → Re-run failed jobs** before then to land it.",
    ].join("\n\n"),
  },
  // v3.0.0: a Broken run that used no retry, either way it is said.
  {
    release: "v3.0.0",
    handBack: "broken-run-no-retry",
    role: "implement",
    body: [
      "<!-- fabrik:implement-run-failed -->",
      "@operator The Implement run on #7 failed: the Implementer gave no valid output.",
      "",
      "This is a Broken run on a Request-changes run, which uses no retry, so the Loop won't run it again. Re-add `agent:implement` on the Ticket (#7) to run it again.",
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  {
    release: "v3.0.0",
    handBack: "broken-run-no-retry",
    role: "implement",
    body: [
      "<!-- fabrik:implement-run-failed -->",
      "@operator The Implement run on #7 failed: the Implementer left its branch, so its work couldn't be read off it.",
      "",
      "This is a Broken run that uses no retry, so the Loop won't run it again. Re-add `agent:implement` on this Ticket to run it again.",
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
  {
    release: "v3.0.0",
    handBack: "infrastructure-failure",
    role: "review",
    body: [
      "@operator The Review run on #7 failed: it crashed.",
      "",
      "This is an Infrastructure failure, so the Loop won't retry it and it doesn't count against the Ticket's retries. Re-add `agent:review` on this PR to run it again.",
      "",
      `[The run](${RUN})`,
    ].join("\n"),
  },
];
