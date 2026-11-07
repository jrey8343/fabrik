// What one setup run says at its end: the setup PR's body, and the closing
// lines in the Operator's terminal. Both ask for the merge only when nothing
// holds it back, and the closing lines give the finishing guidance the
// Operator needs once setup has run.
import type { RunSummary } from "./oneRun.ts";

/** The command that runs setup, at this release. */
export function setupCommand(release: string): string {
  return `curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/main/setup.sh | bash -s -- ${release}`;
}

export interface PrBodyInputs {
  readonly release: string;
  readonly defaultBranch: string;
  readonly summary: RunSummary;
}

const DONE_HEADING = "## What setup did";

export function prBody({ release, defaultBranch, summary }: PrBodyInputs): string {
  const sections = [
    `Sets up Fabrik ${release} in this repo. Setup wrote this PR's files, and did the rest with your own gh and op.`,
    [DONE_HEADING, "", ...(summary.done.length === 0 ? ["An earlier run of setup wrote this PR's files."] : bullets(summary.done))].join("\n"),
    ...(summary.notes.length === 0 ? [] : [["## For the Operator", "", ...bullets(summary.notes)].join("\n")]),
    [
      "## Merging",
      "",
      ...(summary.blockers.length === 0
        ? [mergeAsk("Merge this PR yourself", defaultBranch)]
        : [
            "Don't merge this yet. The Kit's first runs need these, which setup's wizard didn't finish:",
            "",
            ...bullets(summary.blockers),
            "",
            "Run setup again to walk the wizard for them:",
            "",
            "```sh",
            setupCommand(release),
            "```",
          ]),
    ].join("\n"),
  ];
  return `${sections.join("\n\n")}\n`;
}

/**
 * What an earlier run's PR body says setup did, then what this run did, each
 * once. Whoever can write the body wrote those lines, so they keep no control
 * characters, such as a terminal escape, for the closing lines to print.
 */
export function withEarlierDone(body: string | null, done: readonly string[]): string[] {
  const earlier: string[] = [];
  if (body !== null) {
    const lines = body.split(/\r?\n/);
    const start = lines.indexOf(DONE_HEADING);
    if (start !== -1) {
      for (const line of lines.slice(start + 1)) {
        if (line.startsWith("## ")) break;
        if (line.startsWith("- ")) earlier.push(line.slice(2).replace(/[\u0000-\u001f\u007f-\u009f]/g, ""));
      }
    }
  }
  return [...new Set([...earlier, ...done])];
}

export interface ClosingInputs extends PrBodyInputs {
  readonly url: string;
  /** Whether the starter Kit config was written with Dispatch paused. */
  readonly paused: boolean;
}

/** The run's last lines. The wizard clears the screen, so they say again what setup did. */
export function closingLines({ release, defaultBranch, url, summary, paused }: ClosingInputs): string[] {
  return [
    `The setup PR: ${url}`,
    "",
    "What setup did:",
    ...(summary.done.length === 0 ? ["- nothing new in this run"] : bullets(summary.done)),
    ...(summary.notes.length === 0 ? [] : ["", "For the Operator:", ...bullets(summary.notes)]),
    "",
    ...(summary.blockers.length === 0
      ? [mergeAsk("Merge it yourself", defaultBranch)]
      : [
          "Don't merge it yet. The Kit's first runs need these, which the wizard didn't finish:",
          ...bullets(summary.blockers),
          `Run setup again to walk the wizard for them: ${setupCommand(release)}`,
        ]),
    "",
    "Then:",
    ...bullets(guidance(release, paused)),
  ];
}

/** The run's last lines when it wrote no file the default branch lacks, so there's no setup PR. */
export function appliedLines(defaultBranch: string, summary: RunSummary): string[] {
  return [
    "What setup did:",
    ...(summary.done.length === 0 ? ["- nothing new in this run"] : bullets(summary.done)),
    ...(summary.notes.length === 0 ? [] : ["", "For the Operator:", ...bullets(summary.notes)]),
    "",
    `Every file setup writes is already on ${defaultBranch}, so there's no setup PR to open. Setup switched back to ${defaultBranch}.`,
  ];
}

function mergeAsk(who: string, defaultBranch: string): string {
  return (
    `${who} once its gating checks pass. It needs no approving review, and as the repo's admin you're the Merge gate ruleset's one bypass actor. ` +
    `The Loop starts once the caller workflow is on ${defaultBranch}.`
  );
}

/** What the Operator does once setup has run. */
function guidance(release: string, paused: boolean): string[] {
  const command = setupCommand(release);
  return [
    "List the CI checks that must pass in sandbox.checks in .fabrik/config.json, and the Sandbox's setup, build and test commands. " +
      `Then run setup again, so branch protection requires those checks: ${command}`,
    "Once the Fabrik App is on fabrik-runs, each agent run's push job writes its Run record there. " +
      "You can run the Weekly summary by hand from the Actions tab of fabrik-runs (Fabrik weekly summary, Run workflow) instead of waiting for Monday.",
    'To give roles Extra skills from your own Skills sources, pin each source by hand in .fabrik/skills.lock.json ([{ "repository": "owner/name", "sha": "<full commit SHA>" }]). ' +
      'Pick skills under roles.<role>.skills in .fabrik/config.json ("owner/name/skill", for triage, design, implement or review), and say when to use each in that phase\'s .fabrik/<phase>.md. ' +
      "The README's Extra skills section has the details.",
    "The Monitor files an issue for Triage when the default branch goes red, once the Fabrik App's Checks: read is accepted. " +
      'It files one for each production error Sentry reports, once monitor.errors in .fabrik/config.json names the provider, org and project ({ "provider": "sentry", "org": "<org slug>", "project": "<project slug>" }) and the wizard has stored the Sentry token. ' +
      "Until then each source stays dormant, with a quiet note in the hourly tick's step summary.",
    "With Visual evidence on, each PR whose diff touches ui.paths gets an evidence section linking a gallery of its screenshots, and the Reviewer sees them. " +
      "Once the setup PR is merged, turn it on, or change its answers, by running /fabrik-visual-evidence in a Claude session in this repo.",
    ...(paused
      ? [
          "Dispatch is paused, so no Implementer starts until you set max_in_flight in .fabrik/config.json above 0. " +
            "Do that once the tracker's ready-for-agent issues are ones you want built: a push to the default branch that changes it resumes Dispatch straight away.",
        ]
      : []),
    `Running setup again repairs the install (a missing label, secret or shim): ${command}. Kit updates arrive as Dependabot PRs bumping .github/workflows/fabrik.yml.`,
  ];
}

function bullets(lines: readonly string[]): string[] {
  return lines.map((line) => `- ${line}`);
}
