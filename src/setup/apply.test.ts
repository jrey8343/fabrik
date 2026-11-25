// Carrying out a step of the plan on a repo that isn't the Product repo, over
// the world the setup tests run in. The Product repo's own steps are tested as
// one run of the program, in oneRunProgram.test.ts.
import { describe, expect, it } from "vitest";
import { fakeCommands } from "../__fixtures__/setupCommands.ts";
import { anEnvironment, aWorld, environmentOf, worldScript } from "../__fixtures__/setupWorld.ts";
import { apply, describeAction } from "./apply.ts";
import type { SetupAction } from "./plan.ts";

const PRODUCT = { owner: "acme", name: "clinic", defaultBranch: "main", inOrganization: false };
const STORE = "jrey8343/fabrik-runs";

describe("A service account whose step names no environment, as the store's", () => {
  const step: SetupAction = {
    kind: "create-service-account",
    name: "fabrik-jrey8343-fabrik-runs-push",
    vaults: ["Fabrik App"],
    secret: "FABRIK_OP_PUSH_TOKEN",
    repo: STORE,
  };

  it("is named in the plan as a repo-level Actions secret on that repo", () => {
    expect(describeAction(step)).toBe(
      'create the read-only service account "fabrik-jrey8343-fabrik-runs-push" (reads "Fabrik App") and store it as the Actions secret FABRIK_OP_PUSH_TOKEN on jrey8343/fabrik-runs',
    );
  });

  it("stores its token as that repo's repo-level secret, reading no environment", async () => {
    const world = aWorld();
    const commands = fakeCommands(worldScript(world));

    await apply(commands.run, step, "/clinic", PRODUCT);

    expect(commands.calls.map(({ line, input }) => [line, input])).toEqual([
      ["op service-account create fabrik-jrey8343-fabrik-runs-push --vault Fabrik App:read_items --raw", undefined],
      ["gh secret set FABRIK_OP_PUSH_TOKEN --repo jrey8343/fabrik-runs", "ops_token"],
    ]);
    expect(world.environmentCalls).toEqual([]);
  });
});

describe("Deleting a repo-level secret of a repo the step names", () => {
  const step: SetupAction = {
    kind: "delete-repo-secret",
    secret: "FABRIK_OP_PUSH_TOKEN",
    account: "fabrik-jrey8343-fabrik-runs-push",
    environment: "fabrik",
    branch: "trunk",
    repo: STORE,
  };

  it("names that repo in the plan, and the branch whose caller workflow pins the Kit", () => {
    expect(describeAction(step)).toBe(
      "delete the repo-level Actions secret FABRIK_OP_PUSH_TOKEN in jrey8343/fabrik-runs: the Kit trunk pins reads the fabrik environment's",
    );
  });

  it("deletes it on that repo, with one call that names the repo and no environment", async () => {
    const commands = fakeCommands({ "gh secret delete": {} });

    await apply(commands.run, step, "/clinic", PRODUCT);

    expect(commands.calls.map(({ line }) => line)).toEqual(["gh secret delete FABRIK_OP_PUSH_TOKEN --repo jrey8343/fabrik-runs"]);
  });
});

describe("Holding the environment of a repo the step names", () => {
  const step = (found: Extract<SetupAction, { kind: "hold-environment" }>["found"]): SetupAction => ({
    kind: "hold-environment",
    environment: "fabrik",
    branch: "trunk",
    found,
    repo: STORE,
  });

  it("makes it on that repo, held to the branch the step names, and leaves the Product repo's alone", async () => {
    const world = aWorld();
    const commands = fakeCommands(worldScript(world));

    await apply(commands.run, step(null), "/clinic", PRODUCT);

    expect(world.environments.size).toBe(1);
    expect(environmentOf(world, "fabrik", STORE)).toEqual({
      policy: { protected_branches: false, custom_branch_policies: true },
      rules: [{ id: expect.any(Number), name: "trunk", type: "branch" }],
      secrets: new Set(),
    });
    expect(world.environmentCalls.every((line) => line.includes(`repos/${STORE}/environments/fabrik`))).toBe(true);
  });

  it("names that repo in the plan, for one it makes and for one it puts right", () => {
    expect(describeAction(step(null))).toBe("create the fabrik environment in jrey8343/fabrik-runs, held to trunk alone: only a run of trunk is given its secrets");
    expect(describeAction(step({ branches: "selected", rules: [{ id: 3, name: "main", type: "branch" }] }))).toBe(
      "hold the fabrik environment in jrey8343/fabrik-runs to trunk alone: rules main → trunk",
    );
  });

  it("names that repo when GitHub refuses the environment, and when its rules don't read back as the one", async () => {
    const refusing = aWorld();
    refusing.environmentRefusal = "gh: Not Found (HTTP 404)";
    await expect(apply(fakeCommands(worldScript(refusing)).run, step(null), "/clinic", PRODUCT)).rejects.toThrow(
      "GitHub refused the fabrik environment on jrey8343/fabrik-runs: gh: Not Found (HTTP 404). A private repo needs",
    );

    const dropping = aWorld();
    anEnvironment(dropping, { rules: ["main"] }, "fabrik", STORE).dropsNewRules = true;
    await expect(apply(fakeCommands(worldScript(dropping)).run, step(null), "/clinic", PRODUCT)).rejects.toThrow(
      "The fabrik environment on jrey8343/fabrik-runs reads back as none, not held to trunk alone, so Setup stored no token in it. Run setup again.",
    );
  });
});
