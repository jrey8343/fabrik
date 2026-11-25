// fabrik's own hook entry in the docs (Spec #918, #949): the README's Layout
// bullet on it, ADR-0003's addendum on the hook's fetch from github.com and on
// fabrik's hook entry, and ADR-0008's first paragraph with its one changed
// sentence, each as the Ticket writes it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const LAYOUT_BULLET =
  "- `.claude/settings.json` is `fabrik`'s own hook entry. `fabrik` has no caller workflow and no release to read, so its `SessionStart` hook runs `src/session/start.ts --kit` on its own checkout: it installs the Base skills the checkout's `skills.lock.json` pins and every skill under its own `skills/` into its gitignored `.claude/skills/`, with no download of Fabrik, and turns the `mattpocock-skills` plugin off at project scope, as a Product repo's does. A session in `fabrik`, at the Operator's terminal or in a cloud session, runs the pinned skills under their plain names, and a skill edited on a branch is the one the next session on that branch runs.";

const ADDENDUM_HEADING = "## Addendum: a cloud session's hook fetches with git from `github.com`, and `fabrik` has a hook entry too";

const ADDENDUM = [
  "\"Fabrik is a public repo, so cloud-session hooks can fetch it without credentials\" was wrong about a Claude Code cloud session. A cloud session refuses a source archive of any repo that isn't attached to it, a public one included, so both of the hook's downloads failed there with a 403: the hook entry's download of Fabrik, and the fetch's download of each Skills source (#808). The hook stays the one way skills reach a session, at the terminal and in a cloud session alike. A cloud session refuses an archive of a repo that isn't attached, and serves git's own reads of a public one. So the hook fetches Fabrik at its release tag, and each Skills source at its pinned commit, by a shallow git fetch from `github.com`, in a cloud session, at a terminal and in an AFK run alike. The Kit ships nothing new for it.",
  "`fabrik`, which is not a Product repo, has a hook entry of its own, so a session in it runs pinned skills as a Product repo's does, with the `mattpocock-skills` plugin turned off at project scope. It installs from its own checkout: the Base skills its `skills.lock.json` pins and the skills in its own `skills/`. There is no release to read and no Fabrik to download, because the checkout is the Kit. A skill edited on a branch is the one a session on that branch runs. The Console gets the same hook entry as a Product repo, reading the release from its Kit pin, `.github/workflows/kit-pin.yml`, once `fabrik-console`'s default branch is under the Merge gate and it can have an Operator session; until then nothing is built for it.",
  "We kept the hook because the other ways in each give up something this ADR chose. Skills on the Operator's Claude account load in a cloud session but are unpinned, uploaded by hand and the same in every repo. A plugin on that account is known to load there from the changelog alone, and its hook would need the same download. Committed copies vendor upstream, and would put every Extra skill in an AFK run's checkout, which ADR-0008 rules out.",
  "A session with several repos reads no repo's hooks, so the hook delivers nothing there. Decided in [Which skills does an Operator session get, and how do they reach it?](https://github.com/jrey8343/fabrik/issues/805), with the fetch from `github.com` settled in [Settle what the Decisions left for the Specs](https://github.com/jrey8343/fabrik/issues/911).",
];

const ADR_0008_FIRST_PARAGRAPH =
  "This amends ADR-0003. Fabrik's `skills.lock.json` keeps pinning the Base skills, which are Matt Pocock's skills from one Skills source, and they move only with a Kit release. A Product repo that needs more pins its own Skills sources in `.fabrik/skills.lock.json`, a list of `{repository, sha}`. It gives Extra skills from those sources to roles one at a time in `.fabrik/config.json`, as `roles.<role>.skills`. Only triage, design, implement and review take picks. Each AFK run installs the Base skills plus only its own role's Extra skills, and its prompt gets one fixed line naming them. The phase instruction files say when to use them. A local session, a Pairing session or an Operator session installs every pick, because the Operator is at the wheel. Sources must be public. A pick that names an unpinned source is a Kit config error, and so is a pinned source no role picks from, or a skill whose name collides with a Base skill, a Kit skill or another Extra skill.";

/** An ADR's addenda, each from its heading to the next, in order. */
const addendaOf = (adr: string) => adr.split("\n## Addendum: ").slice(1).map((addendum) => `## Addendum: ${addendum.trim()}`);

describe("fabrik's own hook entry in the docs (#949)", () => {
  it("has the README's Layout bullet on it, as written, straight after the one on templates/claude-settings.json", () => {
    const layout = read("README.md").split("\n## Layout\n")[1]?.split("\n## ")[0] ?? "";
    const lines = layout.split("\n");
    const template = lines.findIndex((line) => line.startsWith("- `templates/claude-settings.json`"));

    expect(template).toBeGreaterThanOrEqual(0);
    expect(lines[template + 1]).toBe(LAYOUT_BULLET);
  });

  it("has ADR-0003's addendum on the hook's fetch and fabrik's hook entry, as written, as its last addendum", () => {
    const adr = read("docs/adr/0003-kit-referenced-at-one-pinned-version.md");
    const last = addendaOf(adr).at(-1);

    expect(last).toBe([ADDENDUM_HEADING, ...ADDENDUM].join("\n\n"));
    expect(adr.endsWith(`${ADDENDUM.at(-1)}\n`)).toBe(true);
  });

  it("has ADR-0008's first paragraph with an Operator session among the sessions that install every pick", () => {
    const adr = read("docs/adr/0008-product-repos-pin-extra-skills-per-role.md");

    expect(adr.split("\n\n")[1]).toBe(ADR_0008_FIRST_PARAGRAPH);
  });
});
