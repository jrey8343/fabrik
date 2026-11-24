import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Output } from "@ai-hero/sandcastle";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMPLEMENT_OUTPUT_READERS,
  type ImplementRunKind,
  parseImplementOutput,
  readImplementOutput,
  readRequestChangesRunOutput,
} from "../loop/implementOutput.ts";
import { cleanLaunch } from "../__fixtures__/preflight.ts";
import { checkMeteredBilling } from "../preflight/meteredBilling.ts";
import {
  agentLaunch,
  type Checked,
  claudeArgs,
  leaveFailureReport,
  readyHook,
  replySchemaOf,
  settleReply,
  streamWatch,
  type StreamWatchOptions,
} from "./launch.ts";

const line = (message: unknown) => JSON.stringify(message);
const init = line({ type: "system", subtype: "init", apiKeySource: "none" });
const assistant = line({ type: "assistant", message: { content: [{ type: "text", text: "Working on it" }] } });

const OVERAGE_SIGNALS: readonly (readonly [string, string])[] = [
  [
    "a rate-limit event using overage",
    line({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day", isUsingOverage: true } }),
  ],
  ["a message with overage in use", line({ type: "system", subtype: "status", overageInUse: true })],
  [
    "a rate-limit event of the overage type",
    line({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "overage" } }),
  ],
];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fabrik-stream-watch-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function watching(lines: readonly string[], options?: StreamWatchOptions) {
  const abort = new AbortController();
  const watch = streamWatch(join(dir, "transcript.jsonl"), abort, options);
  for (const text of lines) watch.onAgentStreamEvent({ type: "raw", line: text, iteration: 1, timestamp: new Date() });
  return { abort, watch };
}

describe("The stream watch", () => {
  it("aborts a run whose init message the metered-billing check refuses", () => {
    const { abort } = watching([line({ type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" })]);

    expect(abort.signal.aborted).toBe(true);
  });

  it("warns once, naming them, when the init message still lists tools that schedule a later turn, and lets the run go on (#860)", () => {
    const withTools = (tools: string[]) => line({ type: "system", subtype: "init", apiKeySource: "none", tools });
    const { abort } = watching([
      withTools(["Bash", "ScheduleWakeup", "Read", "CronCreate"]),
      assistant,
      // A session Sandcastle resumed, to ask for a malformed block again, starts with an init message of its own.
      withTools(["Bash", "ScheduleWakeup", "Read", "CronCreate"]),
    ]);

    const warnings = vi.mocked(console.log).mock.calls.map(([text]) => String(text)).filter((text) => text.startsWith("::warning"));
    expect(warnings).toEqual(["::warning title=Scheduling tools at init::ScheduleWakeup, CronCreate"]);
    expect(abort.signal.aborted).toBe(false);
  });

  it("warns of nothing when the init message lists none of them", () => {
    watching([line({ type: "system", subtype: "init", apiKeySource: "none", tools: ["Bash", "Read"] }), init, assistant]);

    expect(vi.mocked(console.log).mock.calls.filter(([text]) => String(text).startsWith("::warning"))).toEqual([]);
  });

  it("lets a run whose stream shows no overage go on, with rotation on", () => {
    const { abort } = watching(
      [init, assistant, line({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day", isUsingOverage: false } })],
      { rotation: true },
    );

    expect(abort.signal.aborted).toBe(false);
  });

  it.each(OVERAGE_SIGNALS)("aborts the run on %s, with rotation on", (_, overage) => {
    const { abort } = watching([init, assistant, overage], { rotation: true });

    expect(abort.signal.aborted).toBe(true);
  });

  it.each(OVERAGE_SIGNALS)("lets the run go on after %s, with rotation off", (_, overage) => {
    const { abort } = watching([init, assistant, overage], { rotation: false });

    expect(abort.signal.aborted).toBe(false);
  });

  it.each(OVERAGE_SIGNALS)("aborts a Fable run on %s, with rotation off (ADR-0034)", (_, overage) => {
    const { abort } = watching([init, assistant, overage], { rotation: false, model: "claude-fable-5-2" });

    expect(abort.signal.aborted).toBe(true);
  });

  it.each(OVERAGE_SIGNALS)("lets a run that isn't Fable go on after %s, with rotation off, as before", (_, overage) => {
    const { abort } = watching([init, assistant, overage], { rotation: false, model: "claude-opus-5-5" });

    expect(abort.signal.aborted).toBe(false);
  });

  it("lets a Fable run whose stream shows no overage go on, with rotation off", () => {
    const { abort } = watching(
      [init, assistant, line({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day", isUsingOverage: false } })],
      { rotation: false, model: "claude-fable-5-2" },
    );

    expect(abort.signal.aborted).toBe(false);
  });

  it.each(OVERAGE_SIGNALS)("lets the run go on after %s, when it isn't told rotation is on", (_, overage) => {
    const { abort } = watching([init, assistant, overage]);

    expect(abort.signal.aborted).toBe(false);
  });

  it("keeps the whole stream in the transcript, the overage line included", async () => {
    const overage = OVERAGE_SIGNALS[0]?.[1] ?? "";
    watching([init, overage], { rotation: true });

    expect(await readFile(join(dir, "transcript.jsonl"), "utf8")).toBe(`${init}\n${overage}\n`);
  });
});

describe("The failure report an overage abort leaves", () => {
  it.each(OVERAGE_SIGNALS)("is usage-credits after %s", async (_, overage) => {
    const { abort, watch } = watching([init, assistant, overage], { rotation: true });
    const path = join(dir, "agent-failure.json");

    await leaveFailureReport(abort.signal.reason, watch, { path, title: "Infrastructure failure" });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      failure: "usage-credits",
      detail: expect.stringContaining("usage credits"),
    });
  });

  it("is usage-credits even when the run had also hit a rejected rate limit", async () => {
    const { abort, watch } = watching(
      [
        init,
        line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "overage" } }),
        line({ type: "result", subtype: "success", is_error: true, result: "API Error" }),
      ],
      { rotation: true },
    );
    const path = join(dir, "agent-failure.json");

    await leaveFailureReport(abort.signal.reason, watch, { path, title: "Infrastructure failure" });

    expect(JSON.parse(await readFile(path, "utf8")).failure).toBe("usage-credits");
  });

  it("is usage-credits for a Fable run with rotation off", async () => {
    const { abort, watch } = watching([init, assistant, OVERAGE_SIGNALS[0]?.[1] ?? ""], { rotation: false, model: "claude-fable-5-2" });
    const path = join(dir, "agent-failure.json");

    await leaveFailureReport(abort.signal.reason, watch, { path, title: "Infrastructure failure" });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      failure: "usage-credits",
      detail: "stopped for spending usage credits: isUsingOverage was true",
    });
  });

  it("isn't usage-credits with rotation off, where the stream watch kills no run that isn't Fable", async () => {
    const { watch } = watching([init, OVERAGE_SIGNALS[1]?.[1] ?? ""], { rotation: false });
    const path = join(dir, "agent-failure.json");

    await leaveFailureReport(new Error("agent exited 1"), watch, { path, title: "Infrastructure failure" });

    expect(JSON.parse(await readFile(path, "utf8")).failure).toBe("crash");
  });
});

describe("The failure report a refused Fable run leaves (ADR-0034)", () => {
  const capped = [
    init,
    line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day_fable", resetsAt: 1_798_000_000 } }),
    line({ type: "result", subtype: "success", is_error: true, result: "API Error" }),
  ];

  it("is the Fable cap, read for the model the run started on", async () => {
    const { watch } = watching(capped, { rotation: true, model: "claude-fable-5-2" });
    const path = join(dir, "agent-failure.json");

    await leaveFailureReport(new Error("agent exited 1"), watch, { path, title: "Infrastructure failure" });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      failure: "fable-cap",
      detail: "seven_day_fable, resets at 2026-12-23T04:26:40.000Z",
      resetsAt: "2026-12-23T04:26:40.000Z",
      refusal: { rateLimitType: "seven_day_fable", resetsAt: 1_798_000_000 },
    });
  });

  it("is the weekly limit on a run that isn't Fable", async () => {
    const { watch } = watching(capped, { rotation: true, model: "claude-opus-5-5" });
    const path = join(dir, "agent-failure.json");

    await leaveFailureReport(new Error("agent exited 1"), watch, { path, title: "Infrastructure failure" });

    expect(JSON.parse(await readFile(path, "utf8")).failure).toBe("weekly-limit");
  });
});

const IMPLEMENT_REPLIES: Readonly<Record<ImplementRunKind, Record<string, unknown>>> = {
  first: { title: "Add the booking page", summary: "Adds the page.", routes: ["/book"] },
  "pull-request": { title: "Add the booking page", summary: "Adds the page.", fix: "Fixed the failing test." },
  "request-changes": {
    title: "Add the booking page",
    summary: "Adds the page.",
    fix: "Moved the button, as asked.",
    reviewMiss: true,
    reviewMissPoints: ["The button was off-screen on mobile."],
    amendsTicket: false,
  },
};

/** What Sandcastle hands back for a reply its schema passed. */
async function validated(read: (value: unknown) => Checked<unknown>, reply: unknown): Promise<unknown> {
  const result = await replySchemaOf(read)["~standard"].validate(reply);
  if (result.issues !== undefined) throw new Error(result.issues.map((issue) => issue.message).join("; "));
  return result.value;
}

describe("A run's reply", () => {
  it.each(Object.keys(IMPLEMENT_REPLIES) as ImplementRunKind[])(
    "of a %s Implement run, checked on the agent side and saved, passes its push job's check",
    async (kind) => {
      const read = IMPLEMENT_OUTPUT_READERS[kind];
      const { saved } = settleReply({ read }, await validated(read, IMPLEMENT_REPLIES[kind]));

      expect(parseImplementOutput(saved, kind)).toMatchObject({ ok: true });
    },
  );

  it.each(Object.keys(IMPLEMENT_REPLIES) as ImplementRunKind[])(
    "of a %s Implement run that gives Trial steps has them read alike on the agent side and by its push job (#963)",
    async (kind) => {
      const trial = {
        summary: " Patients can join a waitlist for a full day. ",
        steps: [
          { route: "/patients/[patientId]", do: "Open any patient from the list.", expect: "Their waitlist days show under their name." },
          { route: "/book", do: "Pick a day with no free slots.", expect: "A waitlist button shows." },
        ],
      };
      const read = IMPLEMENT_OUTPUT_READERS[kind];
      const { output, saved } = settleReply({ read }, await validated(read, { ...IMPLEMENT_REPLIES[kind], trial }));
      const pushed = parseImplementOutput(saved, kind);

      expect(output.trial).toEqual({
        summary: "Patients can join a waitlist for a full day.",
        steps: [
          { do: "Open any patient from the list.", expect: "Their waitlist days show under their name." },
          { route: "/book", do: "Pick a day with no free slots.", expect: "A waitlist button shows." },
        ],
      });
      expect(pushed.ok && pushed.output.trial).toEqual(output.trial);
    },
  );

  it.each(Object.keys(IMPLEMENT_REPLIES) as ImplementRunKind[])(
    "of a %s Implement run whose Trial steps are malformed passes both checks with them left out, so the run lands (#963)",
    async (kind) => {
      const read = IMPLEMENT_OUTPUT_READERS[kind];
      const { output, saved } = settleReply({ read }, await validated(read, { ...IMPLEMENT_REPLIES[kind], trial: { summary: "Patients can join a waitlist.", steps: [{ do: "Pick a full day." }] } }));
      const pushed = parseImplementOutput(saved, kind);

      expect("trial" in output).toBe(false);
      expect(pushed).toMatchObject({ ok: true });
      expect(pushed.ok && "trial" in pushed.output).toBe(false);
    },
  );

  it("is saved as the agent wrote it", async () => {
    const reply = IMPLEMENT_REPLIES["request-changes"];
    const { saved } = settleReply({ read: readRequestChangesRunOutput }, await validated(readRequestChangesRunOutput, reply));

    expect(JSON.parse(saved)).toEqual(reply);
  });

  it("gives the contract's parsed output for the run to describe", async () => {
    const reply = IMPLEMENT_REPLIES["request-changes"];
    const { output } = settleReply({ read: readRequestChangesRunOutput }, await validated(readRequestChangesRunOutput, reply));

    expect(output.answers).toEqual({ reviewMiss: true, points: ["The button was off-screen on mobile."], amendsTicket: false });
  });

  it("that breaks its contract is sent back to the agent with every problem named", async () => {
    const result = await replySchemaOf(readRequestChangesRunOutput)["~standard"].validate({ title: "T", summary: "S", fix: "F" });

    expect(result.issues?.map((issue) => issue.message)).toEqual([
      "reviewMiss must be true or false on a Request-changes run",
      "amendsTicket must be true or false on a Request-changes run",
    ]);
  });

  it("in plain text is checked by its contract and saved trimmed", () => {
    const { output, saved } = settleReply({ text: (reply) => reply.trim().toUpperCase() }, "  Verdict: pass\n");

    expect(output).toBe("VERDICT: PASS");
    expect(saved).toBe("Verdict: pass");
  });
});

describe("A run's onSandboxReady hook", () => {
  const preflight = (hook: string) => hook.slice(hook.lastIndexOf("node "));
  const both = { setup: "mise install", build: "pnpm install" };

  it("ends in the preflight, alone when the run readies nothing", () => {
    const hook = readyHook("none", both);

    expect(hook).toMatch(/^node ".*src\/preflight\/main\.ts"$/);
  });

  it("runs setup, then build, then the preflight, each only if the one before passed, for a run that builds a branch", () => {
    const hook = readyHook("setup-and-build", both);

    expect(hook).toBe(`(mise install) && (pnpm install) && ${preflight(hook)}`);
  });

  it("skips a null build or a null setup for a run that builds a branch, and runs the preflight alone when both are null", () => {
    const hook = readyHook("none", both);

    expect(readyHook("setup-and-build", { setup: "mise install", build: null })).toBe(`(mise install) && ${hook}`);
    expect(readyHook("setup-and-build", { setup: null, build: "pnpm install" })).toBe(`(pnpm install) && ${hook}`);
    expect(readyHook("setup-and-build", { setup: null, build: null })).toBe(hook);
  });

  it("runs setup alone before the preflight, never build, for a run that only runs the Product", () => {
    const hook = readyHook("none", both);

    expect(readyHook("setup", both)).toBe(`(mise install) && ${hook}`);
    expect(readyHook("setup", { setup: null, build: "pnpm install" })).toBe(hook);
  });
});

describe("Every agent's launch (#860)", () => {
  /** A launch command's words, with Sandcastle's single quotes taken off. */
  const words = (command: string) => command.split(" ").map((word) => word.replace(/^'(.*)'$/, "$1"));
  /** An Implementer's output: its block, checked against a first run's contract. */
  const IMPLEMENT = Output.object({ tag: "implement", schema: replySchemaOf(readImplementOutput), maxRetries: 1 });

  it("turns off the tools that schedule a later turn, in arguments the metered-billing preflight lets through", () => {
    const args = claudeArgs("claude-opus-5-5", "high");

    expect(args.join(" ")).toContain("--disallowedTools ScheduleWakeup,CronCreate,CronDelete,CronList");
    expect(args.slice(-2)).toEqual(["-p", "-"]);
    expect(checkMeteredBilling(cleanLaunch({ args }))).toEqual({ kind: "pass" });
  });

  it.each([
    ["with an effort", "high"],
    ["at the CLI's default effort", null],
  ])("starts the agent with exactly the arguments the preflight is given, %s", (_, effort) => {
    const launch = agentLaunch("claude-opus-5-5", effort, IMPLEMENT);
    const { command, stdin } = launch.provider.buildPrintCommand({ prompt: "Build it.", dangerouslySkipPermissions: true });

    expect(words(command)).toEqual(["claude", ...launch.args]);
    expect(launch.args).toEqual(claudeArgs("claude-opus-5-5", effort));
    expect(stdin).toBe("Build it.");
  });

  it("reads a resumed session's reply afresh, so a malformed block Sandcastle asked for again isn't answered with the first", () => {
    const { provider } = agentLaunch("claude-opus-5-5", "high", IMPLEMENT);
    const reply = (text: string) => provider.parseStreamLine(line({ type: "result", subtype: "success", is_error: false, result: text }));
    provider.buildPrintCommand({ prompt: "Build it.", dangerouslySkipPermissions: true });
    reply('<implement>\n{ "title": "" }\n</implement>');

    provider.buildPrintCommand({ prompt: "Emit the block again.", dangerouslySkipPermissions: true, resumeSession: "s1" });

    expect(reply("I can't correct it.")).toEqual([{ type: "result", result: "I can't correct it." }]);
  });

  it("keeps them off when Sandcastle resumes the session to ask for a malformed block again", () => {
    const { provider } = agentLaunch("claude-opus-5-5", "high", IMPLEMENT);
    const { command } = provider.buildPrintCommand({ prompt: "Emit the block again.", dangerouslySkipPermissions: true, resumeSession: "s1" });

    expect(command).toMatch(/ --resume '?s1'? --disallowedTools ScheduleWakeup,CronCreate,CronDelete,CronList -p -$/);
  });
});
