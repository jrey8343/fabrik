import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readKitConfigFromCheckout } from "./checkout.ts";

async function checkoutWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fabrik-checkout-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

describe("Reading the Kit config from a Product checkout", () => {
  it("passes the Skills sources lockfile into resolution", async () => {
    const dir = await checkoutWith({
      ".fabrik/config.json": JSON.stringify({ roles: { design: { skills: ["jrey8343/skills/event-storming"] } } }),
      ".fabrik/skills.lock.json": "not json",
    });

    const result = await readKitConfigFromCheckout(dir, { extraSkills: true });

    expect(!result.ok && result.errors).toEqual([expect.stringMatching(/^\.fabrik\/skills\.lock\.json is not valid JSON/)]);
  });

  it("resolves a checkout's pins and picks", async () => {
    const dir = await checkoutWith({
      ".fabrik/config.json": JSON.stringify({ roles: { design: { skills: ["jrey8343/skills/event-storming"] } } }),
      ".fabrik/skills.lock.json": JSON.stringify([{ repository: "jrey8343/skills", sha: "a".repeat(40) }]),
    });

    const result = await readKitConfigFromCheckout(dir, { extraSkills: true });

    expect(result.ok && result.config.extraSkills.design).toEqual([{ source: "jrey8343/skills", name: "event-storming" }]);
  });
});
