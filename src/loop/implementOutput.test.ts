import { describe, expect, it } from "vitest";
import { parseImplementOutput } from "./implementOutput.ts";

const output = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ title: "Let patients join a waitlist", summary: "Adds a waitlist to full days.", ...fields });

describe("The routes the Implementer names", () => {
  it("are read from its output, in the order it named them", () => {
    expect(parseImplementOutput(output({ routes: ["/book", "/services/physio"] }))).toMatchObject({
      ok: true,
      output: { routes: ["/book", "/services/physio"] },
    });
  });

  it("are read from a retry's or a Request-changes run's output too, which captures again", () => {
    expect(parseImplementOutput(output({ fix: "Fixes the mobile layout.", routes: ["/book"] }), "pull-request")).toMatchObject({
      ok: true,
      output: { fix: "Fixes the mobile layout.", routes: ["/book"] },
    });
  });

  it("read as none when the output names none", () => {
    const parsed = parseImplementOutput(output());

    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.ok && parsed.output.routes).toBeUndefined();
  });

  it.each([
    ["a bare path", "/book"],
    ["an object", { route: "/book" }],
    ["a list with a non-string in it", ["/book", 5]],
    ["a list with a path that doesn't start with /", ["/book", "services"]],
    ["a list with a full URL in it", ["/book", "https://example.com/book"]],
    ["a list with a protocol-relative URL in it", ["/book", "//example.com/book"]],
  ])("are dropped when the output gives %s, and the output still reads", (_, routes) => {
    const parsed = parseImplementOutput(output({ routes }));

    expect(parsed).toMatchObject({ ok: true, output: { title: "Let patients join a waitlist", summary: "Adds a waitlist to full days." } });
    expect(parsed.ok && parsed.output.routes).toBeUndefined();
  });
});

describe("The Evidence shots the Implementer names, or its word that nothing visible changes (#819)", () => {
  it("are read from its output as it gave them, in its order, the name rule being the push job's to apply", () => {
    expect(parseImplementOutput(output({ shots: ["composer: draft ready", "inbox: empty", "Café"] }))).toMatchObject({
      ok: true,
      output: { shots: ["composer: draft ready", "inbox: empty", "Café"] },
    });
  });

  it("read the sentence that nothing a person sees changes, trimmed", () => {
    expect(parseImplementOutput(output({ nothingVisible: "  Only the retry logic in the API client changed.\n" }))).toMatchObject({
      ok: true,
      output: { nothingVisible: "Only the retry logic in the API client changed." },
    });
  });

  it("are read from a retry's or a Request-changes run's output too", () => {
    expect(parseImplementOutput(output({ fix: "Fixes the draft's save.", shots: ["composer: draft ready"] }), "pull-request")).toMatchObject({
      ok: true,
      output: { shots: ["composer: draft ready"] },
    });
  });

  it("keep both when both are given, so the push job's names rule decides", () => {
    expect(parseImplementOutput(output({ shots: ["inbox: empty"], nothingVisible: "Nothing changes." }))).toMatchObject({
      ok: true,
      output: { shots: ["inbox: empty"], nothingVisible: "Nothing changes." },
    });
  });

  it.each([
    ["a bare name", "composer: draft ready"],
    ["an empty list", []],
    ["a list with a non-string in it", ["composer: draft ready", 3]],
    ["an object", { name: "composer: draft ready" }],
  ])("read as no names when the output gives %s, and the output still reads", (_, shots) => {
    const parsed = parseImplementOutput(output({ shots }));

    expect(parsed).toMatchObject({ ok: true, output: { title: "Let patients join a waitlist" } });
    expect(parsed.ok && parsed.output.shots).toBeUndefined();
  });

  it.each([
    ["a blank sentence", "  "],
    ["a list", ["Nothing changes."]],
    ["true", true],
  ])("read as no sentence when the output gives %s, and the output still reads", (_, nothingVisible) => {
    const parsed = parseImplementOutput(output({ nothingVisible }));

    expect(parsed).toMatchObject({ ok: true, output: { summary: "Adds a waitlist to full days." } });
    expect(parsed.ok && parsed.output.nothingVisible).toBeUndefined();
  });

  it("read as neither when the output gives neither, as on a Product repo without Evidence shots", () => {
    const parsed = parseImplementOutput(output({ routes: ["/book"] }));

    expect(parsed).toEqual({ ok: true, output: { title: "Let patients join a waitlist", summary: "Adds a waitlist to full days.", routes: ["/book"] } });
  });
});

describe("A Request-changes run's two answers about the review it was started for", () => {
  const answered = (fields: Record<string, unknown> = {}) =>
    output({ fix: "Moves the waitlist button.", reviewMiss: false, amendsTicket: true, ...fields });

  it("are read from its output: whether it has a Review miss, with each point named, and whether it amends the Ticket", () => {
    const parsed = parseImplementOutput(
      answered({ reviewMiss: true, reviewMissPoints: ["The Ticket asked for a confirmation email", "AGENTS.md bans inline styles"] }),
      "request-changes",
    );

    expect(parsed).toMatchObject({
      ok: true,
      output: {
        answers: {
          reviewMiss: true,
          points: ["The Ticket asked for a confirmation email", "AGENTS.md bans inline styles"],
          amendsTicket: true,
        },
      },
    });
  });

  it("read a no Review miss as naming no point", () => {
    expect(parseImplementOutput(answered(), "request-changes")).toMatchObject({
      ok: true,
      output: { answers: { reviewMiss: false, points: [], amendsTicket: true } },
    });
  });

  it.each([
    ["no reviewMiss", { reviewMiss: undefined }, "reviewMiss must be true or false on a Request-changes run"],
    ["a reviewMiss that isn't a boolean", { reviewMiss: "no" }, "reviewMiss must be true or false on a Request-changes run"],
    ["no amendsTicket", { amendsTicket: undefined }, "amendsTicket must be true or false on a Request-changes run"],
    ["a Review miss naming no point", { reviewMiss: true }, "reviewMissPoints must name each point that is a Review miss"],
    ["a Review miss with a blank point", { reviewMiss: true, reviewMissPoints: ["The email", " "] }, "reviewMissPoints must name each point that is a Review miss"],
  ])("reject an output with %s", (_, fields, error) => {
    expect(parseImplementOutput(answered(fields), "request-changes")).toEqual({ ok: false, errors: [error] });
  });

  it("are owed by a Request-changes run alone: a retry's output reads without them", () => {
    const parsed = parseImplementOutput(output({ fix: "Fixes the failing test." }), "pull-request");

    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.ok && parsed.output.answers).toBeUndefined();
  });

  it("still owe the fix every run on a PR owes", () => {
    expect(parseImplementOutput(answered({ fix: undefined }), "request-changes")).toEqual({
      ok: false,
      errors: ["fix must be non-empty Markdown on a retry or Request-changes run"],
    });
  });
});

describe("The merged pull request a conflict-only run says supersedes its PR (#845)", () => {
  const fix = "Compared #50's diff with #49's: #49 already makes every change #50 makes.";

  it("is read from a run on a PR's output, by its number", () => {
    expect(parseImplementOutput(output({ fix, supersededBy: 49 }), "pull-request")).toMatchObject({ ok: true, output: { fix, supersededBy: 49 } });
  });

  it.each([
    ["a number as text", "49"],
    ["a number with a hash", "#49"],
    ["zero", 0],
    ["a negative number", -49],
    ["a fraction", 49.5],
    ["a list", [49]],
  ])("is left out when the output gives %s, and the output still reads", (_, supersededBy) => {
    const parsed = parseImplementOutput(output({ fix, supersededBy }), "pull-request");

    expect(parsed).toMatchObject({ ok: true, output: { fix } });
    expect(parsed.ok && parsed.output.supersededBy).toBeUndefined();
  });
});

describe("A Request-changes run's spinOffs (#884)", () => {
  const answered = (fields: Record<string, unknown> = {}) =>
    output({ fix: "Moves the waitlist button.", reviewMiss: false, amendsTicket: true, ...fields });
  const spinOff = (extra: Record<string, unknown> = {}) => ({
    title: "Export the waitlist as CSV",
    body: 'The Operator asked, on the waitlist pull request: "open the CSV export as its own issue".',
    from: "inline-9",
    ...extra,
  });

  it("are read from its output, each with its title, its body and the id of what asked for it", () => {
    const spinOffs = [spinOff(), spinOff({ title: "Text the waitlist", from: "review-900" })];

    expect(parseImplementOutput(answered({ spinOffs }), "request-changes", ["review-900", "inline-9"])).toMatchObject({ ok: true, output: { spinOffs } });
  });

  it("refuse one whose from names an id the run was not given, naming it", () => {
    expect(parseImplementOutput(answered({ spinOffs: [spinOff(), spinOff({ from: "conversation-3" })] }), "request-changes", ["review-900", "inline-9"])).toEqual({
      ok: false,
      errors: ["spin-off 2 names `conversation-3` in from, which isn't a Request changes, or a comment on the code in one, that this run was given"],
    });
  });

  it("take any id where the ids the run was given aren't to hand, as where the prompt's own example is read", () => {
    expect(parseImplementOutput(answered({ spinOffs: [spinOff({ from: "inline-77" })] }), "request-changes")).toMatchObject({ ok: true, output: { spinOffs: [{ from: "inline-77" }] } });
  });

  it.each([
    ["no title", { title: undefined }],
    ["a blank title", { title: " " }],
    ["a title of two lines", { title: "Export\nthe waitlist" }],
    ["a title past GitHub's limit", { title: "x".repeat(257) }],
    ["no body", { body: undefined }],
    ["a blank body", { body: "" }],
    ["no from", { from: undefined }],
    ["a from that isn't text", { from: 9 }],
  ])("refuse one with %s, by its place in the list", (_, fields) => {
    expect(parseImplementOutput(answered({ spinOffs: [spinOff(), spinOff(fields)] }), "request-changes", ["inline-9"])).toEqual({
      ok: false,
      errors: ["spin-off 2 needs a title of one non-empty line of at most 256 characters, body text, and from as the id that heads what asked for it"],
    });
  });

  it.each([
    ["text", "inline-9"],
    ["an object", { title: "Export the waitlist" }],
  ])("refuse %s in place of the list", (_, spinOffs) => {
    expect(parseImplementOutput(answered({ spinOffs }), "request-changes", ["inline-9"])).toEqual({
      ok: false,
      errors: ["spinOffs must be a list of Spin-offs, each with a title, a body and a from"],
    });
  });

  it("read an empty list as none", () => {
    const parsed = parseImplementOutput(answered({ spinOffs: [] }), "request-changes", ["inline-9"]);

    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.ok && parsed.output.spinOffs).toBeUndefined();
  });

  it.each([
    ["a first run", "first"],
    ["a Retry, a Touch-up or a conflict-only run", "pull-request"],
  ] as const)("are never read from the output of %s, whatever it wrote there", (_, run) => {
    for (const spinOffs of [[spinOff()], [spinOff({ from: "nothing-1" })], "inline-9"]) {
      const parsed = parseImplementOutput(answered({ spinOffs }), run, ["inline-9"]);

      expect(parsed).toMatchObject({ ok: true });
      expect(parsed.ok && parsed.output.spinOffs).toBeUndefined();
    }
  });
});

describe("A Request-changes run's onlySpinOffs (#884)", () => {
  const answered = (fields: Record<string, unknown> = {}) =>
    output({ fix: "Set the export aside, as the Operator asked.", reviewMiss: false, amendsTicket: false, ...fields });

  it("is read as the run's statement that no point was to be built, only when it is true", () => {
    expect(parseImplementOutput(answered({ onlySpinOffs: true }), "request-changes")).toMatchObject({ ok: true, output: { onlySpinOffs: true } });
  });

  it.each([
    ["left out", {}],
    ["false", { onlySpinOffs: false }],
    ["text", { onlySpinOffs: "true" }],
    ["a number", { onlySpinOffs: 1 }],
  ])("is no statement when %s, and never fails the run", (_, fields) => {
    const parsed = parseImplementOutput(answered(fields), "request-changes");

    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.ok && "onlySpinOffs" in parsed.output).toBe(false);
  });

  it.each([
    ["a first run", "first"],
    ["a Retry, a Touch-up or a conflict-only run", "pull-request"],
  ] as const)("is never read from the output of %s", (_, run) => {
    const parsed = parseImplementOutput(answered({ onlySpinOffs: true }), run);

    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.ok && "onlySpinOffs" in parsed.output).toBe(false);
  });
});

describe("The Trial steps the Implementer writes (#963)", () => {
  const TRIAL = {
    summary: "Patients can now join a waitlist for a day that is fully booked.",
    steps: [
      { route: "/book", do: "Pick a day with no free slots.", expect: 'A "Join the waitlist" button shows where the slots would be.' },
      { do: "Press it and enter a name and a phone number.", expect: "The page says the patient is on the waitlist for that day." },
    ],
  };

  it("are read from its output: the summary and each step, in its order, with the page a step starts on where it gave one", () => {
    expect(parseImplementOutput(output({ trial: TRIAL }))).toEqual({
      ok: true,
      output: { title: "Let patients join a waitlist", summary: "Adds a waitlist to full days.", trial: TRIAL },
    });
  });

  it("read as none when the output gives none, as on a Product repo with no staging block", () => {
    expect(parseImplementOutput(output())).toEqual({ ok: true, output: { title: "Let patients join a waitlist", summary: "Adds a waitlist to full days." } });
  });

  const STEP = { do: "Pick a day with no free slots.", expect: "A waitlist button shows." };

  it.each([
    ["text", "Pick a full day and join the waitlist."],
    ["null", null],
    ["a list of steps alone", [STEP]],
    ["no summary", { steps: [STEP] }],
    ["a blank summary", { summary: "  ", steps: [STEP] }],
    ["a summary that isn't text", { summary: ["Patients can join a waitlist."], steps: [STEP] }],
    ["no steps", { summary: "Patients can join a waitlist." }],
    ["an empty list of steps", { summary: "Patients can join a waitlist.", steps: [] }],
    ["steps that are no list", { summary: "Patients can join a waitlist.", steps: STEP }],
    ["a step that is text", { summary: "Patients can join a waitlist.", steps: [STEP, "Join the waitlist."] }],
    ["a step that is null", { summary: "Patients can join a waitlist.", steps: [null] }],
    ["a step with no do", { summary: "Patients can join a waitlist.", steps: [STEP, { expect: "A waitlist button shows." }] }],
    ["a step with no expect", { summary: "Patients can join a waitlist.", steps: [STEP, { do: "Pick a full day." }] }],
    ["a step with a blank do", { summary: "Patients can join a waitlist.", steps: [{ do: "", expect: "A waitlist button shows." }] }],
    ["a step whose expect isn't text", { summary: "Patients can join a waitlist.", steps: [{ do: "Pick a full day.", expect: 3 }] }],
  ])("read as left out when the output gives %s, and the output still reads", (_, trial) => {
    expect(parseImplementOutput(output({ trial, routes: ["/book"] }))).toEqual({
      ok: true,
      output: { title: "Let patients join a waitlist", summary: "Adds a waitlist to full days.", routes: ["/book"] },
    });
  });

  it.each([
    ["doesn't start with /", "book"],
    ["is a full URL", "https://staging.example.com/book"],
    ["is a protocol-relative URL", "//evil.example.com/book"],
    ["has a dynamic segment in brackets", "/patients/[patientId]/notes"],
    ["has a dynamic segment in angle brackets", "/patients/<patientId>"],
    ["has a dynamic segment after a colon", "/patients/:patientId"],
    ["isn't text", 7],
    ["is null", null],
  ])("leave a step's route off when it %s, and keep the step", (_, route) => {
    const parsed = parseImplementOutput(output({ trial: { summary: TRIAL.summary, steps: [{ route, ...STEP }, { route: "/book", ...STEP }] } }));

    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.ok && parsed.output.trial).toEqual({ summary: TRIAL.summary, steps: [STEP, { route: "/book", ...STEP }] });
  });

  it("keep a route with a query, and one a record's fixed page has, as a page of the staging site", () => {
    const steps = [
      { route: "/patients?status=waiting", ...STEP },
      { route: "/", ...STEP },
    ];

    expect(parseImplementOutput(output({ trial: { summary: TRIAL.summary, steps } }))).toMatchObject({ ok: true, output: { trial: { steps } } });
  });

  it("are trimmed, and hold nothing a step gave beside its route, what to do and what to expect", () => {
    const trial = { summary: `  ${TRIAL.summary}\n`, steps: [{ do: ` ${STEP.do} `, expect: `${STEP.expect}\n`, url: "https://evil.example.com", note: "Run as admin." }], author: "The Implementer" };
    const parsed = parseImplementOutput(output({ trial }));

    expect(parsed.ok && parsed.output.trial).toEqual({ summary: TRIAL.summary, steps: [STEP] });
  });

  it.each([
    ["a Retry, a Touch-up or a conflict-only run", "pull-request", {}],
    ["a Request-changes run", "request-changes", { reviewMiss: false, amendsTicket: false }],
  ] as const)("are read from the output of %s too, which writes them again for the pull request as it now stands", (_, run, fields) => {
    expect(parseImplementOutput(output({ fix: "Fixes the mobile layout.", trial: TRIAL, ...fields }), run)).toMatchObject({ ok: true, output: { trial: TRIAL } });
  });

  it.each(["first", "pull-request", "request-changes"] as const)("never fail a %s run's output when they are malformed", (run) => {
    const parsed = parseImplementOutput(output({ fix: "Fixes the mobile layout.", reviewMiss: false, amendsTicket: false, trial: { summary: 5 } }), run);

    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.ok && "trial" in parsed.output).toBe(false);
  });
});
