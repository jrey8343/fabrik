import { describe, expect, it } from "vitest";
import { type ActionsStep, type KitSaid, kitSaidIn } from "./kitSaid.ts";

const SAID: KitSaid = {
  fabrik: 1,
  route: "implement",
  run: { role: "implement", issue: 7, pullRequest: 50, kind: "retry", retry: 2, model: "claude-opus-5-5" },
  held: [{ role: "review", issue: 51 }],
  replay: null,
};

/** The name GitHub gives the closing step before it completes: the workflow file's text, unevaluated. */
const UNEVALUATED = "${{ steps.route.outputs.kit-said }}";

/** A Kit job's steps as Actions lists them, with its closing step as given. */
function kitJob(closing: ActionsStep): readonly ActionsStep[] {
  return [
    { name: "Set up job", status: "completed", conclusion: "success" },
    { name: "Check out the Kit", status: "completed", conclusion: "success" },
    { name: "Check the Kit config and caller workflow, and route the event", status: "completed", conclusion: "success" },
    closing,
    { name: "Complete job", status: "completed", conclusion: "success" },
  ];
}

describe("The reader of a Kit job's closing step (#616)", () => {
  it("reads the line from a step that completed with success", () => {
    expect(kitSaidIn(kitJob({ name: JSON.stringify(SAID), status: "completed", conclusion: "success" }))).toEqual(SAID);
  });

  it.each([
    ["a declined event", { fabrik: 1, route: "none", run: null, held: [], replay: null }],
    ["a replay", { fabrik: 1, route: "replay", run: null, held: [], replay: { issue: 140, ticket: 12 } }],
    [
      "a Review, whose Ticket is unknown",
      { fabrik: 1, route: "review", run: { role: "review", issue: null, pullRequest: 50, kind: null, retry: 0, model: "claude-opus-5-5" }, held: [], replay: null },
    ],
    [
      "a Digest run, routed to the role with its Ticket and its pull request (#655)",
      { fabrik: 1, route: "digest", run: { role: "digest", issue: 7, pullRequest: 50, kind: null, retry: 0, model: "claude-opus-5-5" }, held: [{ role: "digest", issue: 51 }], replay: null },
    ],
  ])("reads %s", (_, said) => {
    expect(kitSaidIn(kitJob({ name: JSON.stringify(said), status: "completed", conclusion: "success" }))).toEqual(said);
  });

  it.each<[string, ActionsStep]>([
    ["still pending", { name: UNEVALUATED, status: "pending", conclusion: null }],
    ["queued", { name: UNEVALUATED, status: "queued", conclusion: null }],
    ["in progress", { name: UNEVALUATED, status: "in_progress", conclusion: null }],
    ["skipped", { name: UNEVALUATED, status: "completed", conclusion: "skipped" }],
    ["skipped, though its name parses", { name: JSON.stringify(SAID), status: "completed", conclusion: "skipped" }],
    ["failed, though its name parses", { name: JSON.stringify(SAID), status: "completed", conclusion: "failure" }],
    ["completed with the unevaluated text", { name: UNEVALUATED, status: "completed", conclusion: "success" }],
  ])("reads nothing from a closing step %s", (_, closing) => {
    expect(kitSaidIn(kitJob(closing))).toBeNull();
  });

  it("reads nothing from a job with no closing step, as from a release before it", () => {
    expect(kitSaidIn(kitJob({ name: "Set up Node", status: "completed", conclusion: "success" }))).toBeNull();
    expect(kitSaidIn([])).toBeNull();
  });

  it.each([
    ["at a version this release doesn't know", { ...SAID, fabrik: 2 }],
    ["with no version", { ...SAID, fabrik: undefined }],
    ["with a route the Kit has none of", { ...SAID, route: "deploy" }],
    ["with a run kind the Kit has none of", { ...SAID, run: { ...SAID.run, kind: "rerun" } }],
    ["with a run of no role", { ...SAID, run: { ...SAID.run, role: "operator" } }],
    ["with a Retry number that isn't one", { ...SAID, run: { ...SAID.run, retry: "2" } }],
    ["with a held run of no number", { ...SAID, held: [{ role: "review" }] }],
    ["with a replay of no Ticket", { ...SAID, replay: { issue: 140 } }],
    ["that isn't an object", [SAID]],
  ])("reads nothing from a line %s", (_, line) => {
    expect(kitSaidIn(kitJob({ name: JSON.stringify(line), status: "completed", conclusion: "success" }))).toBeNull();
  });
});
