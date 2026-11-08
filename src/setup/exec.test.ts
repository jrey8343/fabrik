// The real command runner: each command gets the environment setup gives it,
// so the chosen 1Password account reaches it as OP_ACCOUNT.
import { describe, expect, it } from "vitest";
import { spawnRun } from "./exec.ts";

describe("Running a command", () => {
  it("gives it the environment it's passed", async () => {
    const ran = await spawnRun(process.execPath, ["-e", "process.stdout.write(process.env.OP_ACCOUNT ?? 'unset')"], {
      cwd: import.meta.dirname,
      env: { OP_ACCOUNT: "acme.1password.com" },
    });

    expect(ran).toEqual({ code: 0, stdout: "acme.1password.com", stderr: "" });
  });

  it("answers exit 127 for a command that isn't installed", async () => {
    const ran = await spawnRun("fabrik-no-such-command", [], { cwd: import.meta.dirname });

    expect(ran).toEqual({ code: 127, stdout: "", stderr: "fabrik-no-such-command isn't installed, or isn't on PATH" });
  });
});
