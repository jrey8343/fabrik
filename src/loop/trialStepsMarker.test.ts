import { describe, expect, it } from "vitest";
import type { TrialSteps } from "./implementOutput.ts";
import { trialStepsIn, trialStepsMarker, withoutTrialSteps } from "./markers.ts";

const TRIAL: TrialSteps = {
  summary: "Patients can now join a waitlist for a day that is fully booked.",
  steps: [
    { route: "/book", do: "Pick a day with no free slots.", expect: 'A "Join the waitlist" button shows where the slots would be.' },
    { do: "Press it and enter a name and a phone number.", expect: "The page says the patient is on the waitlist for that day." },
  ],
};

/** A pull request's body as the push job writes it: the Implementer's summary, the marker, then the Closes line. */
const bodyWith = (...markers: string[]) => ["Adds a waitlist to full days.", ...markers, "Closes #7"].join("\n\n");

describe("the marker that keeps a pull request's Trial steps on it (#963)", () => {
  it("is one hidden line, which reads back as the Trial steps the writer wrote it for", () => {
    const marker = trialStepsMarker(TRIAL);

    expect(marker).toMatch(/^<!-- fabrik:trial-steps \{.*\} -->$/);
    expect(marker).not.toContain("\n");
    expect(trialStepsIn(bodyWith(marker))).toEqual(TRIAL);
  });

  it("reads back unchanged text that holds Markdown, HTML, comment delimiters, mentions and line breaks, none of which leaves its one line", () => {
    const awkward: TrialSteps = {
      summary: "The **waitlist** <b>button</b> --> shows <!-- on --> full days.\nThanks @jrey, see [the docs](https://evil.example.com) and `code`.",
      steps: [
        { route: "/book?day=full&view=<week>", do: "Press <script>alert(1)</script> -->\n\n## A heading\u2028and a separator", expect: "<!-- fabrik:trial-steps {} --> isn't read as a marker; @someone isn't told." },
        { do: 'Type "quotes", a \\ backslash and a } brace.', expect: "- [ ] a task list item\r\n| a | table |" },
      ],
    };
    const marker = trialStepsMarker(awkward);

    expect(marker).not.toMatch(/[\n\r\u2028\u2029@]/);
    expect(marker.indexOf("-->")).toBe(marker.length - "-->".length);
    expect(marker.slice("<!--".length)).not.toContain("<");
    expect(trialStepsIn(bodyWith(marker))).toEqual(awkward);
  });

  it("is replaced by a later run's: of two in a body, the last is the pull request's", () => {
    const later: TrialSteps = { summary: "Patients can join and leave a waitlist.", steps: [{ route: "/waitlist", do: "Press Leave.", expect: "The day is gone from the list." }] };

    expect(trialStepsIn(bodyWith(trialStepsMarker(TRIAL), trialStepsMarker(later)))).toEqual(later);
  });

  it("reads from a line the Operator indented, or one GitHub ended with a carriage return", () => {
    expect(trialStepsIn(`Adds a waitlist.\r\n\r\n  ${trialStepsMarker(TRIAL)}\r\n\r\nCloses #7`)).toEqual(TRIAL);
  });

  it("reads a body that keeps none as null: a pull request merged before the Kit kept them, or one whose run gave none", () => {
    expect(trialStepsIn("")).toBeNull();
    expect(trialStepsIn(bodyWith())).toBeNull();
    expect(trialStepsIn(bodyWith(`<!-- fabrik:ui-evidence {"run":9100,"artifact":9202} -->`))).toBeNull();
    expect(trialStepsIn(`It wrote ${trialStepsMarker(TRIAL)} in a sentence.`)).toBeNull();
  });

  it.each([
    ["isn't JSON", "<!-- fabrik:trial-steps {summary} -->"],
    ["holds no steps", `<!-- fabrik:trial-steps {"summary":"Patients can join a waitlist.","steps":[]} -->`],
    ["holds a step with nothing to expect", `<!-- fabrik:trial-steps {"summary":"Patients can join a waitlist.","steps":[{"do":"Pick a full day."}]} -->`],
    ["holds no summary", `<!-- fabrik:trial-steps {"steps":[{"do":"Pick a full day.","expect":"A button shows."}]} -->`],
  ])("reads a marker that %s as none, and the readable one before it still counts", (_, broken) => {
    expect(trialStepsIn(bodyWith(broken))).toBeNull();
    expect(trialStepsIn(bodyWith(trialStepsMarker(TRIAL), broken))).toEqual(TRIAL);
  });

  it("holds what it reads to the contract's rule for a step's route, so no link is built to a page that isn't the staging site's as written", () => {
    const written = `<!-- fabrik:trial-steps {"summary":"Patients can join a waitlist.","steps":[{"route":"//evil.example.com","do":"Pick a full day.","expect":"A button shows."},{"route":"/patients/[patientId]","do":"Open a patient.","expect":"Their days show."}]} -->`;

    expect(trialStepsIn(bodyWith(written))).toEqual({
      summary: "Patients can join a waitlist.",
      steps: [
        { do: "Pick a full day.", expect: "A button shows." },
        { do: "Open a patient.", expect: "Their days show." },
      ],
    });
  });
});

describe("agent text without a Trial steps marker of its own (#963)", () => {
  it("loses every line that is one, or is spaced or spelled near enough to pass for one, with the blank lines that set it apart", () => {
    const forged = ["Adds a waitlist to full days.", "", trialStepsMarker(TRIAL), "", "Tested on a full day.", "", "  <!--fabrik:trial-steps {\"summary\":\"x\"}-->", "", "```", "<!-- fabrik:trial-steps -->", "```"].join("\n");

    expect(withoutTrialSteps(forged)).toBe(["Adds a waitlist to full days.", "", "Tested on a full day.", "", "```", "```"].join("\n"));
    expect(trialStepsIn(withoutTrialSteps(forged))).toBeNull();
  });

  it("loses one it ends with, and the blank lines before it", () => {
    expect(withoutTrialSteps(`Adds a waitlist to full days.\n\n${trialStepsMarker(TRIAL)}\n`)).toBe("Adds a waitlist to full days.");
  });

  it("is as it was when it holds none, a mention of the marker in a sentence and another marker included", () => {
    const text = ["Adds a waitlist.", "", "The Kit keeps the steps in `<!-- fabrik:trial-steps {…} -->` on the pull request.", "", "<!-- fabrik:ui-evidence-start -->", ""].join("\n");

    expect(withoutTrialSteps(text)).toBe(text);
  });
});
