import { describe, expect, it } from "vitest";
import { DEFAULT_KIT_CONFIG } from "./config.ts";
import { aComment } from "../read/builders.ts";
import {
  BARE_SESSION_ENVIRONMENT,
  isSessionAddress,
  OPERATOR_SESSION_MARKER,
  operatorSessionIn,
  operatorSessionMarker,
  sessionAddressOf,
  sessionEnvironmentOf,
} from "./operatorSession.ts";

const ADDRESS = "https://claude.ai/code/session_01GcsNdk1yVNhd1T31USEtv1";

/** The Operator's comment `body` at `at`. */
const byOperator = (body: string, at = "2026-11-08T10:00:00Z") => aComment(body, at, { author: "operator", byBot: false });

/** A session's report as the Operator posts it: the marker line, then the link. */
const aReport = (address: string) => `<!-- fabrik:operator-session ${address} -->\nAn Operator session is working this issue: [open it](${address}).`;

describe("The Session environment a repo's Operator sessions open in", () => {
  it("is the bare one, operator-sessions, which holds no credential", () => {
    expect(BARE_SESSION_ENVIRONMENT).toBe("operator-sessions");
  });

  it("is the one a Kit config names in console.session_environment", () => {
    const config = { ...DEFAULT_KIT_CONFIG, console: { ...DEFAULT_KIT_CONFIG.console, sessionEnvironment: "shop-sessions" } };

    expect(sessionEnvironmentOf(config)).toBe("shop-sessions");
  });

  it("is the bare one for a Kit config that names none", () => {
    expect(sessionEnvironmentOf(DEFAULT_KIT_CONFIG)).toBe("operator-sessions");
  });

  it("is the bare one for null: a Kit config not read, invalid, or not there", () => {
    expect(sessionEnvironmentOf(null)).toBe("operator-sessions");
  });
});

describe("An Operator session's address, from CLAUDE_CODE_REMOTE_SESSION_ID", () => {
  it("is the cse_ id as a session_ id on claude.ai/code", () => {
    expect(sessionAddressOf("cse_abc")).toBe("https://claude.ai/code/session_abc");
    expect(sessionAddressOf("cse_01Gc-sN_dk1")).toBe("https://claude.ai/code/session_01Gc-sN_dk1");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["already a session_ id", "session_abc"],
    ["a UUID", "4c1c4ab8-31bd-44ef-8e0d-ae1af7fd135e"],
    ["cse_ alone", "cse_"],
    ["cse_ and a character no id holds", "cse_abc/def"],
  ])("is none for a variable %s", (_, sessionId) => {
    expect(sessionAddressOf(sessionId)).toBeNull();
  });
});

describe("A session's address", () => {
  it("is https://claude.ai/code/session_ and an id", () => {
    expect(isSessionAddress(ADDRESS)).toBe(true);
    expect(isSessionAddress("https://claude.ai/code/session_a-b_c")).toBe(true);
  });

  it.each([
    ["no id", "https://claude.ai/code/session_"],
    ["another host", "https://evil.example/code/session_abc"],
    ["plain http", "http://claude.ai/code/session_abc"],
    ["a path after the id", "https://claude.ai/code/session_abc/more"],
    ["a query after the id", "https://claude.ai/code/session_abc?x=1"],
    ["a cse_ id", "https://claude.ai/code/cse_abc"],
    ["a space before it", " https://claude.ai/code/session_abc"],
  ])("is not one with %s", (_, text) => {
    expect(isSessionAddress(text)).toBe(false);
  });
});

describe("The Operator session marker", () => {
  it("is fabrik:operator-session", () => {
    expect(OPERATOR_SESSION_MARKER).toBe("fabrik:operator-session");
  });

  it("is a hidden line holding the address", () => {
    expect(operatorSessionMarker("https://claude.ai/code/session_abc")).toBe("<!-- fabrik:operator-session https://claude.ai/code/session_abc -->");
  });
});

describe("The Operator session on an issue, from its comments", () => {
  it("is the address in the Operator's marker", () => {
    expect(operatorSessionIn([byOperator(aReport(ADDRESS))], "operator")).toBe(ADDRESS);
  });

  it("is none with no marker", () => {
    expect(operatorSessionIn([byOperator("Looks good to me.")], "operator")).toBeNull();
    expect(operatorSessionIn([], "operator")).toBeNull();
  });

  it("is none from another person's marker", () => {
    expect(operatorSessionIn([aComment(aReport(ADDRESS), "2026-11-08T10:00:00Z", { author: "stranger", byBot: false })], "operator")).toBeNull();
  });

  it("is none from the Fabrik App's marker", () => {
    expect(operatorSessionIn([aComment(aReport(ADDRESS), "2026-11-08T10:00:00Z")], "operator")).toBeNull();
  });

  it.each([
    ["on another host", "https://evil.example/code/session_abc"],
    ["with a path after the id", "https://claude.ai/code/session_abc/more"],
    ["with a query after the id", "https://claude.ai/code/session_abc?x=1"],
    ["of another form", "https://claude.ai/code/cse_abc"],
  ])("is none from a marker whose address is %s", (_, address) => {
    expect(operatorSessionIn([byOperator(aReport(address))], "operator")).toBeNull();
  });

  it("is none from a marker on the second line", () => {
    expect(operatorSessionIn([byOperator(`Picking this up.\n${aReport(ADDRESS)}`)], "operator")).toBeNull();
  });

  it("is none from a first line holding more than the marker", () => {
    expect(operatorSessionIn([byOperator(`> <!-- fabrik:operator-session ${ADDRESS} -->`)], "operator")).toBeNull();
    expect(operatorSessionIn([byOperator(`<!-- fabrik:operator-session ${ADDRESS} --> and more`)], "operator")).toBeNull();
  });

  it("is the later of the Operator's two markers, whichever comes first in the list", () => {
    const earlier = byOperator(aReport("https://claude.ai/code/session_earlier"), "2026-11-08T10:00:00Z");
    const later = byOperator(aReport("https://claude.ai/code/session_later"), "2026-11-08T12:00:00Z");

    expect(operatorSessionIn([earlier, later], "operator")).toBe("https://claude.ai/code/session_later");
    expect(operatorSessionIn([later, earlier], "operator")).toBe("https://claude.ai/code/session_later");
  });

  it("is the Operator's marker when a stranger's comes after it", () => {
    const own = byOperator(aReport(ADDRESS), "2026-11-08T10:00:00Z");
    const stranger = aComment(aReport("https://claude.ai/code/session_stranger"), "2026-11-08T12:00:00Z", { author: "stranger", byBot: false });

    expect(operatorSessionIn([own, stranger], "operator")).toBe(ADDRESS);
  });

  it("counts a marker followed by a footer", () => {
    const body = `${aReport(ADDRESS)}\n\nGenerated by [Claude Code](https://claude.ai/code)`;

    expect(operatorSessionIn([byOperator(body)], "operator")).toBe(ADDRESS);
  });

  it("counts a marker whose line ends with a carriage return", () => {
    expect(operatorSessionIn([byOperator(aReport(ADDRESS).replace("\n", "\r\n"))], "operator")).toBe(ADDRESS);
  });
});
