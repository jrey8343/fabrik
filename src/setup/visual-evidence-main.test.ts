// The Visual evidence writer's program, run as /fabrik-visual-evidence runs it:
// from the Product repo's checkout, with the answers on stdin.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../__fixtures__/skillsArchive.ts";

const KIT = resolve(import.meta.dirname, "..", "..");
const WRITER = join(KIT, "src/setup/visual-evidence-main.ts");
const STARTER = join(KIT, "templates/fabrik-config.json");

const pilot = {
  ui: {
    paths: ["src/pages/**", "src/components/**"],
    serve: "npm run preview",
    url: "http://localhost:4321",
    before_url: "https://clinic.example.com",
    default_routes: ["/"],
  },
  preview: { url: "https://deploy-preview-{pr}--clinic.netlify.app" },
};

/** A Product checkout holding the starter Kit config, as setup leaves it. */
async function aCheckout(config: string | null = null): Promise<string> {
  const checkout = await tempDir("visual-evidence");
  await mkdir(join(checkout, ".fabrik"));
  await writeFile(join(checkout, ".fabrik/config.json"), config ?? (await readFile(STARTER, "utf8")));
  return checkout;
}

function writer(checkout: string, answers: unknown, args: string[] = []) {
  return spawnSync(process.execPath, [WRITER, ...args], { cwd: checkout, input: JSON.stringify(answers), encoding: "utf8", timeout: 30_000 });
}

const kitConfigOf = (checkout: string) => readFile(join(checkout, ".fabrik/config.json"), "utf8");

describe("The Visual evidence writer's program", () => {
  it("writes the answers into the checkout's Kit config and says which blocks it wrote", async () => {
    const checkout = await aCheckout();

    const run = writer(checkout, pilot);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("Wrote the ui and preview blocks to .fabrik/config.json.\n");
    expect(await kitConfigOf(checkout)).toBe(await readFile(join(KIT, "src/__fixtures__/starterWithVisualEvidence.json"), "utf8"));
  });

  it("writes nothing, and says so, when it's run again with the same answers", async () => {
    const checkout = await aCheckout();
    writer(checkout, pilot);
    const before = await stat(join(checkout, ".fabrik/config.json"));

    const run = writer(checkout, pilot);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(".fabrik/config.json already holds these answers, so nothing was written.\n");
    expect((await stat(join(checkout, ".fabrik/config.json"))).mtimeMs).toBe(before.mtimeMs);
  });

  it("names each problem with answers the Kit config would refuse, and leaves the file as it was", async () => {
    const checkout = await aCheckout();
    const starter = await kitConfigOf(checkout);

    const run = writer(checkout, { ui: { ...pilot.ui, paths: [], url: "localhost:4321" } });

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      [
        "Nothing was written to .fabrik/config.json:",
        "- ui.paths is empty: list at least one glob of the files that make a pull request UI",
        '- ui.url is "localhost:4321": a URL must start with http:// or https://',
        "",
      ].join("\n"),
    );
    expect(await kitConfigOf(checkout)).toBe(starter);
  });

  it("takes no arguments, only the answers on stdin", async () => {
    const run = writer(await aCheckout(), pilot, ["--ui-path=src/**"]);

    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/^Usage: node src\/setup\/visual-evidence-main\.ts < answers\.json/);
  });
});

describe("Setup leaves Visual evidence to /fabrik-visual-evidence", () => {
  const VISUAL_EVIDENCE_FLAG = /--(ui|preview)-[a-z-]+/g;

  it("takes no Visual evidence flag", () => {
    const run = spawnSync(process.execPath, [join(KIT, "src/setup/main.ts")], { encoding: "utf8", timeout: 30_000 });

    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/^Usage: /);
    expect(run.stderr.match(VISUAL_EVIDENCE_FLAG)).toBeNull();
  });
});
