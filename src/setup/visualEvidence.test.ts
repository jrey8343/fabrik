// The Visual evidence writer, which /fabrik-visual-evidence runs once the
// Operator has confirmed its answers: it writes only the Kit config's ui and
// preview blocks, the Operator's file kept byte for byte around them.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { writeVisualEvidence } from "./visualEvidence.ts";

const KIT = resolve(import.meta.dirname, "..", "..");
const lines = (...text: string[]) => text.join("\n");
/** The writer given these answers as the skill passes them, in JSON. */
const write = (config: string | null, answers: unknown) => writeVisualEvidence(config, JSON.stringify(answers));

/** The answers as the skill gives them: the blocks, spelled as Kit config spells them. */
const answers = {
  ui: {
    paths: ["src/**"],
    serve: "npm run preview",
    url: "http://localhost:4321",
    before_url: null,
    default_routes: [],
  },
  preview: { url: null },
};

/** Every answer given, as for the Pilot. */
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

describe("The Visual evidence writer", () => {
  it("adds the ui and preview blocks before the closing brace of a Kit config that has neither, every other byte kept", () => {
    const theirs = lines(
      "{",
      '  "roles": { "implement": { "model": "claude-sonnet-5-5", "effort": null, "timeout_minutes": 90 } },',
      '  "operator": "jrey8343"',
      "}",
      "",
    );

    expect(write(theirs, answers)).toEqual({
      ok: true,
      written: ["ui", "preview"],
      config: lines(
        "{",
        '  "roles": { "implement": { "model": "claude-sonnet-5-5", "effort": null, "timeout_minutes": 90 } },',
        '  "operator": "jrey8343",',
        '  "ui": {',
        '    "paths": ["src/**"],',
        '    "serve": "npm run preview",',
        '    "url": "http://localhost:4321",',
        '    "before_url": null,',
        '    "default_routes": []',
        "  },",
        '  "preview": {',
        '    "url": null',
        "  }",
        "}",
        "",
      ),
    });
  });

  describe("a Kit config that declares production", () => {
    // The Operator's own spacing, so a block reprinted as Prettier prints it would differ.
    const production = '"production": {"url": "https://clinic.example.com",   "environment": "production"}';

    it("replaces the ui and preview blocks around it, leaving the production block byte for byte as it was", () => {
      const theirs = lines("{", '  "operator": "jrey8343",', `  ${production},`, '  "ui": null,', '  "preview": { "url": null }', "}", "");

      const result = write(theirs, pilot);

      expect(result).toEqual({
        ok: true,
        written: ["ui", "preview"],
        config: lines(
          "{",
          '  "operator": "jrey8343",',
          `  ${production},`,
          '  "ui": {',
          '    "paths": ["src/pages/**", "src/components/**"],',
          '    "serve": "npm run preview",',
          '    "url": "http://localhost:4321",',
          '    "before_url": "https://clinic.example.com",',
          '    "default_routes": ["/"]',
          "  },",
          '  "preview": {',
          '    "url": "https://deploy-preview-{pr}--clinic.netlify.app"',
          "  }",
          "}",
          "",
        ),
      });
    });

    it("adds the ui and preview blocks after a production block that closes the Kit config, the block's own bytes kept", () => {
      const theirs = lines("{", '  "operator": "jrey8343",', `  ${production}`, "}", "");

      const result = write(theirs, { preview: { url: null } });

      expect(result).toEqual({
        ok: true,
        written: ["preview"],
        config: lines("{", '  "operator": "jrey8343",', `  ${production},`, '  "preview": {', '    "url": null', "  }", "}", ""),
      });
    });

    it("never writes production, which isn't a block it writes", () => {
      const theirs = lines("{", `  ${production}`, "}", "");

      expect(write(theirs, { ...answers, production: { url: "https://elsewhere.example", environment: null } })).toEqual({
        ok: false,
        problems: ['The answers hold "production", which isn\'t a block this writes: it writes only ui and preview'],
      });
    });
  });

  it("replaces the starter's ui and preview blocks where they stand, leaving the rest of it as setup wrote it", () => {
    const starter = readFileSync(resolve(KIT, "templates", "fabrik-config.json"), "utf8");
    // The starter with these answers written in by hand. Prettier 3.6.2 prints its ui and preview blocks exactly so.
    const expected = readFileSync(resolve(KIT, "src", "__fixtures__", "starterWithVisualEvidence.json"), "utf8");

    expect(write(starter, pilot)).toEqual({ ok: true, written: ["ui", "preview"], config: expected });
  });

  it("puts a Kit config that was all on one line one member per line, as Prettier breaks it, each member's own text kept", () => {
    const oneLine = '{ "max_in_flight": 1, "operator": "jrey8343", "ui": null }\n';

    expect(write(oneLine, answers)).toEqual({
      ok: true,
      written: ["ui", "preview"],
      config: lines(
        "{",
        '  "max_in_flight": 1,',
        '  "operator": "jrey8343",',
        '  "ui": {',
        '    "paths": ["src/**"],',
        '    "serve": "npm run preview",',
        '    "url": "http://localhost:4321",',
        '    "before_url": null,',
        '    "default_routes": []',
        "  },",
        '  "preview": {',
        '    "url": null',
        "  }",
        "}",
        "",
      ),
    });
  });

  // Prettier 3.6.2 prints each exactly so: once a block inside a one-line object breaks, every object around it breaks too.
  it("puts a one-line Kit config one member per line when it changes a field of a one-line block in it", () => {
    const oneLine = '{ "operator": "jrey8343", "preview": { "url": null } }\n';

    expect(write(oneLine, { preview: { url: "https://example.com" } })).toEqual({
      ok: true,
      written: ["preview"],
      config: lines("{", '  "operator": "jrey8343",', '  "preview": {', '    "url": "https://example.com"', "  }", "}", ""),
    });
  });

  it("does the same when it changes the fields of a one-line ui block one by one", () => {
    const oneLine = '{ "operator": "jrey8343", "ui": { "paths": ["src/**"], "serve": "npm start", "url": "http://localhost:3000" } }\n';

    expect(write(oneLine, { ui: { serve: "npm run preview", url: "http://localhost:4321" } })).toEqual({
      ok: true,
      written: ["ui"],
      config: lines(
        "{",
        '  "operator": "jrey8343",',
        '  "ui": {',
        '    "paths": ["src/**"],',
        '    "serve": "npm run preview",',
        '    "url": "http://localhost:4321"',
        "  }",
        "}",
        "",
      ),
    });
  });

  it("keeps the Kit config's own indent and line endings", () => {
    const tabbed = '{\r\n\t"operator": "jrey8343",\r\n\t"ui": null\r\n}\r\n';

    expect(write(tabbed, pilot)).toEqual({
      ok: true,
      written: ["ui", "preview"],
      config: [
        "{",
        '\t"operator": "jrey8343",',
        '\t"ui": {',
        '\t\t"paths": ["src/pages/**", "src/components/**"],',
        '\t\t"serve": "npm run preview",',
        '\t\t"url": "http://localhost:4321",',
        '\t\t"before_url": "https://clinic.example.com",',
        '\t\t"default_routes": ["/"]',
        "\t},",
        '\t"preview": {',
        '\t\t"url": "https://deploy-preview-{pr}--clinic.netlify.app"',
        "\t}",
        "}",
        "",
      ].join("\r\n"),
    });
  });

  // Prettier-checked: at this indent an 80-column line, comma and all, stays on one line, and an 81-column one breaks.
  it("puts each item of a list on its own line once the list no longer fits in 80 columns", () => {
    const at = (width: number) => {
      const glob = "x".repeat(width - '    "paths": [""],'.length);
      const written = write('{\n  "operator": "jrey8343"\n}\n', { ui: { ...answers.ui, paths: [glob] } });
      return { glob, config: written.ok ? written.config : "" };
    };

    const fits = at(80);
    expect(fits.config).toContain(`\n    "paths": ["${fits.glob}"],\n`);
    const overflows = at(81);
    expect(overflows.config).toContain(`\n    "paths": [\n      "${overflows.glob}"\n    ],\n`);
  });

  it("changes only the fields of a block it has that the answers change, keeping each field they leave out", () => {
    const theirs = lines(
      "{",
      '  "operator": "jrey8343",',
      '  "ui": {',
      '    "paths": ["src/**"],',
      '    "serve": "npm run preview",',
      '    "url": "http://localhost:4321",',
      '    "default_routes": ["/", "/book"]',
      "  }",
      "}",
      "",
    );
    const changed = { ui: { paths: ["src/**"], serve: "npm run dev", url: "http://localhost:4321", before_url: null } };

    expect(write(theirs, changed)).toEqual({
      ok: true,
      written: ["ui"],
      config: lines(
        "{",
        '  "operator": "jrey8343",',
        '  "ui": {',
        '    "paths": ["src/**"],',
        '    "serve": "npm run dev",',
        '    "url": "http://localhost:4321",',
        '    "default_routes": ["/", "/book"],',
        '    "before_url": null',
        "  }",
        "}",
        "",
      ),
    });
  });

  it("checks the block as it would be written, the fields the answers leave out included", () => {
    const theirs = JSON.stringify({ ui: { paths: ["src/**"], serve: "npm run preview", url: "http://localhost:4321", default_routes: ["book"] } });

    expect(write(theirs, { ui: { paths: ["src/**"], serve: "npm run dev", url: "http://localhost:4321" } })).toEqual({
      ok: false,
      problems: ['ui.default_routes[0] is "book": a route must be a path starting with one /, such as /book'],
    });
  });

  it("writes nothing for answers the Kit config would refuse, naming every problem", () => {
    const wrong = {
      ui: { paths: [], serve: "npm run preview", url: "localhost:4321", before_url: null, default_routes: ["book"] },
      preview: { url: "https://pr-{number}.clinic.dev" },
    };

    expect(write(lines("{", '  "operator": "jrey8343"', "}", ""), wrong)).toEqual({
      ok: false,
      problems: [
        "ui.paths is empty: list at least one glob of the files that make a pull request UI",
        'ui.url is "localhost:4321": a URL must start with http:// or https://',
        'ui.default_routes[0] is "book": a route must be a path starting with one /, such as /book',
        'preview.url is "https://pr-{number}.clinic.dev": {number} is not a placeholder; a preview URL may use only {pr}, {branch_slug} and {sha}',
      ],
    });
  });

  describe("what it refuses before checking the answers", () => {
    const theirs = '{\n  "operator": "jrey8343"\n}\n';

    it("writes no Kit config into a repo that has none, since the Kit isn't set up there", () => {
      expect(write(null, answers)).toEqual({
        ok: false,
        problems: [".fabrik/config.json is missing, so the Kit isn't set up in this repo: run Setup first"],
      });
    });

    it.each([
      ["{ oops", /^\.fabrik\/config\.json is not valid JSON: /],
      ["[]\n", /^\.fabrik\/config\.json must be an object$/],
    ])("leaves a Kit config that isn't a JSON object (%j) for the Operator to fix, rather than overwrite it", (broken, problem) => {
      const written = write(broken, answers);

      expect(written.ok).toBe(false);
      expect(written.ok ? [] : written.problems).toEqual([expect.stringMatching(problem)]);
    });

    it("takes the answers only as the ui and preview blocks, naming anything else", () => {
      expect(writeVisualEvidence(theirs, "ui: src/**")).toEqual({
        ok: false,
        problems: [expect.stringMatching(/^The answers are not valid JSON: /)],
      });
      for (const wrong of [["src/**"], {}]) {
        expect(write(theirs, wrong)).toEqual({ ok: false, problems: ["The answers must be a JSON object holding a ui block, a preview block or both"] });
      }
      expect(write(theirs, { ...answers, sandbox: { build: "npm run build" }, uiPaths: ["src/**"] })).toEqual({
        ok: false,
        problems: [
          'The answers hold "sandbox", which isn\'t a block this writes: it writes only ui and preview',
          'The answers hold "uiPaths", which isn\'t a block this writes: it writes only ui and preview',
        ],
      });
    });
  });

  describe("an app whose pages sit behind a sign-in", () => {
    /** The sign-in answers, as the skill gives them once the Operator confirms each. */
    const signedIn = {
      sign_in: { owner: "npm run sign-in -- owner", client: "npm run sign-in -- client" },
      sign_in_path: "/login",
      signed_in_routes: [
        { route: "/book/**", as: null },
        { route: "/admin/**", as: "owner" },
        { route: "/**", as: "client" },
      ],
    };
    const theirs = lines(
      "{",
      '  "operator": "jrey8343",',
      '  "ui": {',
      '    "paths": ["src/**"],',
      '    "serve": "npm run preview",',
      '    "url": "http://localhost:4321",',
      '    "before_url": "https://clinic.example.com",',
      '    "default_routes": ["/"]',
      "  }",
      "}",
      "",
    );

    // Each rule is printed expanded, as every object the writer prints is: Prettier keeps an expanded object so.
    it("adds the sign-in fields to the ui block it has, keeping every other byte", () => {
      expect(write(theirs, { ui: signedIn })).toEqual({
        ok: true,
        written: ["ui"],
        config: lines(
          "{",
          '  "operator": "jrey8343",',
          '  "ui": {',
          '    "paths": ["src/**"],',
          '    "serve": "npm run preview",',
          '    "url": "http://localhost:4321",',
          '    "before_url": "https://clinic.example.com",',
          '    "default_routes": ["/"],',
          '    "sign_in": {',
          '      "owner": "npm run sign-in -- owner",',
          '      "client": "npm run sign-in -- client"',
          "    },",
          '    "sign_in_path": "/login",',
          '    "signed_in_routes": [',
          "      {",
          '        "route": "/book/**",',
          '        "as": null',
          "      },",
          "      {",
          '        "route": "/admin/**",',
          '        "as": "owner"',
          "      },",
          "      {",
          '        "route": "/**",',
          '        "as": "client"',
          "      }",
          "    ]",
          "  }",
          "}",
          "",
        ),
      });
    });

    it("writes them with the rest of a new ui block", () => {
      const written = write(lines("{", '  "operator": "jrey8343"', "}", ""), { ui: { ...answers.ui, ...signedIn } });

      expect(written.ok && JSON.parse(written.config)).toEqual({ operator: "jrey8343", ui: { ...answers.ui, ...signedIn } });
    });

    it("writes nothing when run again with the same answers, however the identities are ordered", () => {
      const once = write(theirs, { ui: signedIn });
      const config = once.ok ? once.config : "";
      const reordered = { ...signedIn, sign_in: { client: signedIn.sign_in.client, owner: signedIn.sign_in.owner } };

      expect(write(config, { ui: reordered })).toEqual({ ok: true, written: [], config });
    });

    it("replaces the identities and rules it has with the answers', rather than merging them", () => {
      const once = write(theirs, { ui: signedIn });
      const config = once.ok ? once.config : "";
      const narrowed = { sign_in: { owner: "npm run sign-in -- owner" }, signed_in_routes: [{ route: "/**", as: "owner" }] };

      const again = write(config, { ui: narrowed });

      expect(again.ok && again.written).toEqual(["ui"]);
      expect(again.ok && JSON.parse(again.config).ui).toEqual({ ...JSON.parse(config).ui, ...narrowed });
    });

    it("writes nothing for a sign-in the Kit config would refuse, naming every problem", () => {
      const deployed = lines(
        "{",
        '  "ui": { "paths": ["src/**"], "serve": "npm run preview", "url": "https://staging.clinic.example.com" }',
        "}",
        "",
      );
      const wrong = { sign_in: { owner: " " }, signed_in_routes: [{ route: "/**", as: "admin" }] };

      expect(write(deployed, { ui: wrong })).toEqual({
        ok: false,
        problems: [
          "ui.sign_in.owner is \" \": a sign-in command can't be blank",
          "ui.sign_in_path is missing: with ui.sign_in, name the route the app sends a signed-out visitor to",
          'ui.signed_in_routes[0].as is "admin": it must be null or one of ui.sign_in\'s identities, owner',
          'ui.url is "https://staging.clinic.example.com": a ui with sign_in serves on a loopback address, such as http://localhost:4321, so a sign-in only ever reaches the Sandbox\'s own server',
        ],
      });
    });
  });

  describe("run again with the same answers", () => {
    const theirs = '{\n  "max_in_flight": 1,\n  "operator": "jrey8343"\n}\n';

    it("writes nothing once the Kit config holds them", () => {
      const once = write(theirs, pilot);
      const config = once.ok ? once.config : "";

      expect(write(config, pilot)).toEqual({ ok: true, written: [], config });
    });

    it("writes nothing however the Operator has formatted the blocks, or ordered their fields", () => {
      const { ui, preview } = pilot;
      const reordered = JSON.stringify({ preview, operator: "jrey8343", ui: Object.fromEntries(Object.entries(ui).reverse()) });

      expect(write(reordered, pilot)).toEqual({ ok: true, written: [], config: reordered });
    });

    it("writes only the block that changed", () => {
      const once = write(theirs, pilot);
      const config = once.ok ? once.config : "";
      const moved = { ...pilot, preview: { url: "https://pr-{pr}.clinic.dev" } };

      const again = write(config, moved);

      expect(again.ok && again.written).toEqual(["preview"]);
      expect(again.ok && again.config).toBe(config.replace("https://deploy-preview-{pr}--clinic.netlify.app", "https://pr-{pr}.clinic.dev"));
    });
  });
});

describe("The Visual evidence skill's offers", () => {
  const skill = readFileSync(resolve(KIT, "skills", "fabrik-visual-evidence", "SKILL.md"), "utf8");
  const suggest = skill.slice(skill.indexOf("## 3. Suggest the answers"), skill.indexOf("## 4."));

  it("offers production.url for ui.before_url when Kit config declares one, saying where the offer came from", () => {
    const before = suggest.split("\n").find((line) => line.startsWith("- `ui.before_url`")) ?? "";

    expect(before).toContain("offer `production.url`");
    expect(before).toContain("say it came from the `production` block");
  });
});
