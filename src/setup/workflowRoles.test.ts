// What a Product repo's workflow asks for, as Setup reads it with no YAML
// library: whether it can be started by workflow_dispatch, and each job's
// id-token: write and environment.
import { describe, expect, it } from "vitest";
import { workflowRolesOf } from "./workflowRoles.ts";

/** A workflow with these lines for its `on:` and one job, `deploy`, naming the environment `production`. */
function triggeredBy(...on: readonly string[]): string {
  return ["name: Deploy", ...on, "jobs:", "  deploy:", "    runs-on: ubuntu-latest", "    environment: production", "    steps:", "      - run: ./deploy", ""].join("\n");
}

describe("Whether a workflow can be started by workflow_dispatch", () => {
  it("reads on: as a single event", () => {
    expect(workflowRolesOf(triggeredBy("on: workflow_dispatch")).dispatchable).toBe(true);
  });

  it.each<[string, readonly string[]]>([
    ["a flow list", ["on: [push, workflow_dispatch]"]],
    ["a block list, one event to a line", ["on:", "  - push", "  - workflow_dispatch"]],
    ["a block with workflow_dispatch: as a key and nothing under it", ["on:", "  push:", "    branches: [main]", "  workflow_dispatch:"]],
    [
      "a block with workflow_dispatch: and its inputs",
      ["on:", "  workflow_dispatch:", "    inputs:", "      ref:", "        type: string", "        required: true", "  push:", "    branches: [main]"],
    ],
    ["a quoted \"on\": key", ['"on":', "  workflow_dispatch: {}"]],
    ["a quoted event in a flow list", ["on: [push, 'workflow_dispatch']"]],
    ["a comment after the event", ["on: workflow_dispatch # by hand"]],
  ])("reads on: as %s", (_, on) => {
    expect(workflowRolesOf(triggeredBy(...on)).dispatchable).toBe(true);
  });

  it.each<[string, readonly string[]]>([
    ["a single other event", ["on: push"]],
    ["a flow list without it", ["on: [push, pull_request]"]],
    ["a block list without it", ["on:", "  - push", "  - workflow_call"]],
    ["a block without it, though an input below another event is named so", ["on:", "  workflow_call:", "    inputs:", "      workflow_dispatch:", "        type: string"]],
    ["a commented-out event", ["on:", "  push:", "  # workflow_dispatch:"]],
    ["no on: at all", []],
  ])("reads on: as %s as not dispatchable", (_, on) => {
    expect(workflowRolesOf(triggeredBy(...on)).dispatchable).toBe(false);
  });
});

/** A dispatchable workflow with these top-level lines after its `on:`, then these jobs' lines under `jobs:`. */
function dispatchedWith(top: readonly string[], jobs: readonly string[]): string {
  return ["name: Promote", "on: workflow_dispatch", ...top, "jobs:", ...jobs, ""].join("\n");
}

describe("Whether each job asks for id-token: write", () => {
  const idTokens = (text: string) => workflowRolesOf(text).jobs.map((job) => [job.name, job.idToken]);

  it("reads a job's own permissions:, as a block and inline", () => {
    const text = dispatchedWith(
      [],
      [
        "  deploy:",
        "    runs-on: ubuntu-latest",
        "    permissions:",
        "      contents: read",
        "      id-token: write",
        "    steps:",
        "      - run: ./deploy",
        "  plan:",
        "    permissions: { contents: read, 'id-token': write }",
        "    runs-on: ubuntu-latest",
        "  read:",
        "    permissions:",
        "      contents: read",
        "      id-token: read",
        "    runs-on: ubuntu-latest",
      ],
    );

    expect(idTokens(text)).toEqual([
      ["deploy", true],
      ["plan", true],
      ["read", false],
    ]);
  });

  it("reads the workflow's top-level permissions: for a job with none of its own, write-all included", () => {
    const job = ["  deploy:", "    runs-on: ubuntu-latest"];

    expect(idTokens(dispatchedWith(["permissions:", "  id-token: write", "  contents: read"], job))).toEqual([["deploy", true]]);
    expect(idTokens(dispatchedWith(["permissions: write-all"], job))).toEqual([["deploy", true]]);
    expect(idTokens(dispatchedWith(["permissions: read-all"], job))).toEqual([["deploy", false]]);
    expect(idTokens(dispatchedWith([], job))).toEqual([["deploy", false]]);
  });

  it("reads a job's own permissions: in place of the workflow's, so {} or read-all on the job asks for nothing", () => {
    const top = ["permissions:", "  id-token: write"];

    expect(idTokens(dispatchedWith(top, ["  deploy:", "    permissions: {}", "    runs-on: ubuntu-latest"]))).toEqual([["deploy", false]]);
    expect(idTokens(dispatchedWith(top, ["  deploy:", "    permissions: read-all", "    runs-on: ubuntu-latest"]))).toEqual([["deploy", false]]);
    expect(idTokens(dispatchedWith(top, ["  deploy:", "    permissions:", "      contents: write", "    runs-on: ubuntu-latest"]))).toEqual([["deploy", false]]);
    expect(idTokens(dispatchedWith(["permissions: {}"], ["  deploy:", "    permissions: write-all"]))).toEqual([["deploy", true]]);
  });

  it("never reads a step's own keys for the job's", () => {
    const text = dispatchedWith(
      [],
      ["  deploy:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: ./action", "        with:", "          permissions: write-all", "          environment: production"],
    );

    expect(workflowRolesOf(text).jobs).toEqual([{ name: "deploy", idToken: false, environment: null }]);
  });
});

describe("The environment each job names", () => {
  const environments = (jobs: readonly string[]) => workflowRolesOf(dispatchedWith([], jobs)).jobs.map((job) => [job.name, job.environment]);

  it("reads environment: as a name, quoted or not", () => {
    expect(environments(["  deploy:", "    environment: production", "  dns:", '    environment: "Production – DNS"'])).toEqual([
      ["deploy", "production"],
      ["dns", "Production – DNS"],
    ]);
  });

  it("reads environment: as a block with name:, whatever else is under it", () => {
    expect(environments(["  deploy:", "    environment:", "      url: https://clinic.example.com", "      name: production", "    runs-on: ubuntu-latest"])).toEqual([
      ["deploy", "production"],
    ]);
  });

  it("gives a name written as an expression as written", () => {
    expect(environments(["  deploy:", "    environment: ${{ inputs.environment }}"])).toEqual([["deploy", "${{ inputs.environment }}"]]);
    expect(environments(["  deploy:", "    environment:", "      name: ${{ github.ref_name == 'main' && 'production' || 'staging' }}"])).toEqual([
      ["deploy", "${{ github.ref_name == 'main' && 'production' || 'staging' }}"],
    ]);
  });

  it("gives null for a job that names none", () => {
    expect(environments(["  test:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm test"])).toEqual([["test", null]]);
  });
});
