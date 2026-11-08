import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMPLEMENT_OUTPUT_READERS,
  type ImplementRunKind,
  parseImplementOutput,
  readRequestChangesRunOutput,
} from "../loop/implementOutput.ts";
import { type Checked, leaveFailureReport, replySchemaOf, settleReply, streamWatch } from "./launch.ts";

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

function watching(lines: readonly string[], options?: { rotation: boolean }) {
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

  it("isn't usage-credits with rotation off, where the stream watch kills nothing", async () => {
    const { watch } = watching([init, OVERAGE_SIGNALS[1]?.[1] ?? ""], { rotation: false });
    const path = join(dir, "agent-failure.json");

    await leaveFailureReport(new Error("agent exited 1"), watch, { path, title: "Infrastructure failure" });

    expect(JSON.parse(await readFile(path, "utf8")).failure).toBe("crash");
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
