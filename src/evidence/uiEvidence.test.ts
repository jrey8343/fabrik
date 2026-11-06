import { describe, expect, it } from "vitest";
import type { UiConfig } from "../kit/config.ts";
import { isUi, routesFor } from "./uiEvidence.ts";

/** The Pilot's ui block: an Astro site served from its build. */
const ui: UiConfig = {
  paths: ["src/**/*.astro", "src/components/**", "public/**"],
  serve: "node ./dist/server/entry.mjs",
  url: "http://127.0.0.1:4321",
  beforeUrl: "https://www.penrithphysio.com.au",
  defaultRoutes: ["/", "/book", "/services"],
};

describe("Whether a pull request is UI", () => {
  it("is true when a changed path matches one of ui.paths' globs", () => {
    expect(isUi(["src/lib/booking.ts", "src/pages/book.astro"], ui)).toBe(true);
  });

  it("is true for a file deep under a folder glob", () => {
    expect(isUi(["src/components/booking/Calendar.tsx"], ui)).toBe(true);
  });

  it("is false when no changed path matches any of them", () => {
    expect(isUi(["src/lib/booking.ts", "README.md", "src/pages/api/book.ts"], ui)).toBe(false);
  });

  it("is false for an empty diff", () => {
    expect(isUi([], ui)).toBe(false);
  });

  it("is false without a ui block, whatever changed", () => {
    expect(isUi(["src/pages/book.astro", "src/components/Header.astro"], null)).toBe(false);
  });
});

/** A Ticket body in the shape a Design session writes, naming these routes. */
const ticket = (whatToBuild: string) =>
  ["## Parent", "", "#12", "", "## What to build", "", whatToBuild, "", "## Acceptance criteria", "", "- [ ] It works"].join("\n");

describe("The routes UI evidence captures", () => {
  it("are the routes the Ticket names, as paths in backticks, each with its reason", () => {
    const body = ticket("Add a waitlist to full days on `/book`, and link it from `/services/physio`.");

    expect(routesFor(body, [], ["/"])).toEqual([
      { route: "/book", reason: "ticket" },
      { route: "/services/physio", reason: "ticket" },
    ]);
  });

  it("count only a code span that is one path starting with a single /, never other code or a bare path", () => {
    const body = ticket(
      [
        "Change `src/pages/book.astro` so /book shows a waitlist, then run `npm run build`.",
        "Don't load `//cdn.example.com/widget.js`, keep `GET /api/slots` as it is, and leave `/book now` alone.",
        "The home page, `/`, links to it.",
      ].join("\n"),
    );

    expect(routesFor(body, [], [])).toEqual([{ route: "/", reason: "ticket" }]);
  });

  it("never count a path in a fenced code block, which is quoted, not named", () => {
    const body = ticket(
      [
        "Show the waitlist on `/book`. The router already has:",
        "",
        "```ts",
        "const routes = { book: `/book/legacy`, admin: `/admin` };",
        "```",
      ].join("\n"),
    );

    expect(routesFor(body, [], [])).toEqual([{ route: "/book", reason: "ticket" }]);
  });

  it("go on with the Implementer's routes after the Ticket's, and leave out the defaults", () => {
    const body = ticket("Add a waitlist to full days on `/book`.");

    expect(routesFor(body, ["/book/waitlist", "/"], ["/services", "/contact"])).toEqual([
      { route: "/book", reason: "ticket" },
      { route: "/book/waitlist", reason: "implementer" },
      { route: "/", reason: "implementer" },
    ]);
  });

  it("are the Implementer's alone when the Ticket names none", () => {
    expect(routesFor(ticket("Add a waitlist to full days."), ["/book"], ["/"])).toEqual([
      { route: "/book", reason: "implementer" },
    ]);
  });

  it("fall back to ui.default_routes when neither the Ticket nor the Implementer names any", () => {
    expect(routesFor(ticket("Tighten the spacing in the footer."), [], ["/", "/book", "/services"])).toEqual([
      { route: "/", reason: "default" },
      { route: "/book", reason: "default" },
      { route: "/services", reason: "default" },
    ]);
  });

  it("hold each route once, with the reason it was first named for", () => {
    const body = ticket("Add a waitlist to `/book`. The waitlist shows on `/book` only when the day is full.");

    expect(routesFor(body, ["/book", "/book/waitlist", "/book/waitlist"], ["/"])).toEqual([
      { route: "/book", reason: "ticket" },
      { route: "/book/waitlist", reason: "implementer" },
    ]);
  });

  it("hold each default route once", () => {
    expect(routesFor(ticket("Tighten the footer."), [], ["/", "/book", "/"])).toEqual([
      { route: "/", reason: "default" },
      { route: "/book", reason: "default" },
    ]);
  });

  it("stop at four, trimming the Implementer's routes after the Ticket's", () => {
    const body = ticket("Add a waitlist to `/book` and show it on `/book/physio`.");

    expect(routesFor(body, ["/book", "/book/massage", "/book/pilates", "/book/hydro"], [])).toEqual([
      { route: "/book", reason: "ticket" },
      { route: "/book/physio", reason: "ticket" },
      { route: "/book/massage", reason: "implementer" },
      { route: "/book/pilates", reason: "implementer" },
    ]);
  });

  it("keep every route the Ticket names, even past four, and then take none of the Implementer's", () => {
    const body = ticket("Restyle `/`, `/book`, `/services`, `/about`, `/contact` and `/blog`.");

    expect(routesFor(body, ["/pricing"], ["/faq"]).map(({ route, reason }) => `${reason} ${route}`)).toEqual([
      "ticket /",
      "ticket /book",
      "ticket /services",
      "ticket /about",
      "ticket /contact",
      "ticket /blog",
    ]);
  });

  it("stop at four default routes too", () => {
    const defaults = ["/", "/book", "/services", "/about", "/contact"];

    expect(routesFor(ticket("Tighten the footer."), [], defaults).map(({ route }) => route)).toEqual([
      "/",
      "/book",
      "/services",
      "/about",
    ]);
  });

  it("are none at all when nothing names a route and there are no defaults, which capture records as no-routes", () => {
    expect(routesFor(ticket("Tighten the spacing in the footer."), [], [])).toEqual([]);
  });
});
