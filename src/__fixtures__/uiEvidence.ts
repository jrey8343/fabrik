// UI evidence (#153) as the push job's event carries it, for the core's tests.
import type { ShotsCollected } from "../evidence/shotsCollect.ts";
import type { CaptureResult } from "../evidence/uiEvidence.ts";
import type { UiConfig } from "../kit/config.ts";
import type { ImplementEvidence } from "../loop/types.ts";

/** A ui block under which a change to a page or a component is UI. */
export const UI: UiConfig = {
  paths: ["src/pages/**", "src/components/**"],
  serve: "npm run preview",
  url: "http://127.0.0.1:4321",
  beforeUrl: null,
  defaultRoutes: ["/"],
};

/** A ui block whose UI evidence comes from the Evidence shots the Required check `e2e` uploads (#818). */
export const SHOTS_UI: UiConfig = { ...UI, defaultRoutes: [], shots: { check: "e2e", artifact: "fabrik-evidence-shots" } };

/** The head the Implement run built, and capture captured. */
export const CAPTURED_SHA = "4f2b9c0e1d3a5b7c9e0f2a4b6c8d0e1f3a5b7c9d";

/** The Evidence page the push job links: the unzipped artifact 9201 of its own run, 9100. */
export const EVIDENCE_PAGE = "https://github.com/acme/shop/actions/runs/9100/artifacts/9201";

/** The Implementer's /waitlist, captured After at both viewports, 200 OK. */
export const CAPTURED: CaptureResult = {
  outcome: "captured",
  headSha: CAPTURED_SHA,
  captures: [
    { route: "/waitlist", reason: "implementer", viewport: "mobile", side: "after", status: 200, image: "after-mobile-waitlist.png" },
    { route: "/waitlist", reason: "implementer", viewport: "desktop", side: "after", status: 200, image: "after-desktop-waitlist.png" },
  ],
};

/**
 * What the Review's jobs collected of a head's Evidence shots (#820): the
 * `e2e` check's run at HEAD_SHA produced both of the pull request's names,
 * `composer: draft ready` with its Journey and path, beside a third shot no
 * one named.
 */
export function aShotsCollected(overrides: Partial<ShotsCollected> = {}): ShotsCollected {
  return {
    check: "e2e",
    artifact: "fabrik-evidence-shots",
    head: "a".repeat(40),
    failure: null,
    red: false,
    named: [
      { name: "composer: draft ready", journey: "write-a-clinical-note", path: "/patients/6f1b2c3d/notes/new", images: { mobile: "draft.mobile.png", desktop: "draft.desktop.png" } },
      { name: "inbox: empty", images: { mobile: "inbox.mobile.png", desktop: "inbox.desktop.png" } },
    ],
    missed: [],
    produced: ["composer: draft ready", "inbox: empty", "sign in: form"],
    pastLimit: 0,
    sendsBack: false,
    ...overrides,
  };
}

/** What the push job of run 9100 knows of its Implement run's UI evidence: this capture result, or none when left out. */
export function anEvidence(result?: CaptureResult, overrides: Partial<ImplementEvidence> = {}): ImplementEvidence {
  return {
    ...(result === undefined ? {} : { result }),
    headSha: CAPTURED_SHA,
    run: 9100,
    artifact: 9202,
    evidencePage: EVIDENCE_PAGE,
    ...overrides,
  };
}
