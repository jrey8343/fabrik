// Sentry API responses for the Sentry translator's tests (src/monitor/sentry.ts),
// in the `acme` org's `clinic` project. There is no live Sentry project to record
// from yet, so they are built from the response examples in Sentry's published
// API schema (getsentry/sentry-api-schema), with a booking site's errors in place
// of the examples' own. Trimmed to the fields Sentry documents for each endpoint,
// less the bulky ones nothing reads (raw stack traces, `_meta`, a release's
// commits), and scrubbed: every person, address and secret is made up, at
// example.com or .example, in RFC 5737's documentation IP range, a phone number ACMA
// keeps for fiction, or a `-fixture` value.
//
// The latest event still carries what Sentry sends that a Monitor issue must
// never show: request data, breadcrumbs, user, tags, contexts and frame
// variables, so the tests can prove none of it reaches the facts.

/**
 * `GET /api/0/projects/acme/clinic/issues/?statsPeriod=24h`: two unresolved
 * groups, each with 24 hourly `[unix seconds, events]` buckets ending at
 * 2026-11-06T08:00Z. CLINIC-3 is an exception (9 events in 24 hours, 57 in
 * all); CLINIC-1 is a logged message with no exception and no culprit (3 events
 * in 24 hours).
 */
export const PROJECT_ISSUES_24H = [
  {
    annotations: [],
    assignedTo: null,
    count: "57",
    culprit: "POST /api/book",
    firstSeen: "2026-10-29T03:12:44.104000Z",
    hasSeen: false,
    id: "6031250812",
    isBookmarked: false,
    isPublic: false,
    isSubscribed: true,
    lastSeen: "2026-11-06T08:41:09.512000Z",
    level: "error",
    logger: null,
    metadata: {
      filename: "/app/src/lib/booking.ts",
      type: "Error",
      value: "Couldn't load the booking slots",
    },
    numComments: 0,
    permalink: "https://acme.sentry.io/issues/6031250812/",
    project: { id: "4508123000000001", name: "clinic", slug: "clinic" },
    shareId: null,
    shortId: "CLINIC-3",
    stats: {
      "24h": [
        [1793869200, 0], [1793872800, 0], [1793876400, 0], [1793880000, 0],
        [1793883600, 0], [1793887200, 0], [1793890800, 0], [1793894400, 0],
        [1793898000, 0], [1793901600, 0], [1793905200, 0], [1793908800, 0],
        [1793912400, 0], [1793916000, 0], [1793919600, 0], [1793923200, 0],
        [1793926800, 0], [1793930400, 0], [1793934000, 0], [1793937600, 2],
        [1793941200, 0], [1793944800, 3], [1793948400, 1], [1793952000, 3],
      ],
    },
    status: "unresolved",
    statusDetails: {},
    subscriptionDetails: null,
    title: "Error: Couldn't load the booking slots",
    type: "error",
    userCount: 4,
  },
  {
    annotations: [],
    assignedTo: { type: "user", id: "1", name: "Operator Fixture", email: "operator-fixture@example.com" },
    count: "12",
    culprit: "",
    firstSeen: "2026-10-31T22:05:17.880000Z",
    hasSeen: true,
    id: "6031244470",
    isBookmarked: false,
    isPublic: false,
    isSubscribed: true,
    lastSeen: "2026-11-05T12:18:52.031000Z",
    level: "error",
    logger: null,
    metadata: { title: "Nookal returned no practitioners" },
    numComments: 0,
    permalink: "https://acme.sentry.io/issues/6031244470/",
    project: { id: "4508123000000001", name: "clinic", slug: "clinic" },
    shareId: null,
    shortId: "CLINIC-1",
    stats: {
      "24h": [
        [1793869200, 1], [1793872800, 0], [1793876400, 0], [1793880000, 2],
        [1793883600, 0], [1793887200, 0], [1793890800, 0], [1793894400, 0],
        [1793898000, 0], [1793901600, 0], [1793905200, 0], [1793908800, 0],
        [1793912400, 0], [1793916000, 0], [1793919600, 0], [1793923200, 0],
        [1793926800, 0], [1793930400, 0], [1793934000, 0], [1793937600, 0],
        [1793941200, 0], [1793944800, 0], [1793948400, 0], [1793952000, 0],
      ],
    },
    status: "unresolved",
    statusDetails: {},
    subscriptionDetails: null,
    title: "Nookal returned no practitioners",
    type: "default",
    userCount: 0,
  },
];

/**
 * `GET /api/0/organizations/acme/issues/6031250812/events/latest/`: CLINIC-3's
 * latest event, a booking POST that failed. Its exception is chained, as the
 * Node SDK's linked errors send it: the cause first, then the error it caused,
 * each stack's frames oldest first. The in-app frames are the site's own
 * `/app/src` files; the rest are Node's and Astro's.
 */
export const CLINIC_3_LATEST_EVENT = {
  id: "c2f1e0d9b8a74f6e9d3c2b1a0f9e8d7c",
  eventID: "c2f1e0d9b8a74f6e9d3c2b1a0f9e8d7c",
  groupID: "6031250812",
  projectID: "4508123000000001",
  title: "Error: Couldn't load the booking slots",
  message: "",
  platform: "node",
  type: "error",
  dateCreated: "2026-11-06T08:41:09.512000Z",
  dateReceived: "2026-11-06T08:41:10.004000Z",
  culprit: "POST /api/book",
  location: "/app/src/lib/booking.ts",
  dist: null,
  metadata: {
    filename: "/app/src/lib/booking.ts",
    type: "Error",
    value: "Couldn't load the booking slots",
  },
  tags: [
    { key: "environment", value: "production" },
    { key: "handled", value: "no" },
    { key: "level", value: "error" },
    { key: "mechanism", value: "auto.http.astro" },
    { key: "release", value: "clinic@2026.11.05+3f9c2a1" },
    { key: "runtime", value: "node v22.11.0" },
    { key: "server_name", value: "ip-10-0-1-23.ap-southeast-2.compute.internal" },
    { key: "transaction", value: "POST /api/book" },
    { key: "url", value: "https://clinic.example/api/book" },
    { key: "user", value: "email:patient-fixture@example.com" },
  ],
  user: {
    id: "user-fixture",
    email: "patient-fixture@example.com",
    username: null,
    ip_address: "203.0.113.7",
    name: "Patient Fixture",
    data: null,
  },
  entries: [
    {
      type: "exception",
      data: {
        values: [
          {
            type: "SyntaxError",
            value: "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
            module: null,
            threadId: null,
            mechanism: { type: "chained", source: "cause", handled: true, exception_id: 1, parent_id: 0 },
            stacktrace: {
              frames: [
                {
                  function: "availableSlots",
                  filename: "/app/src/lib/nookal.ts",
                  absPath: "/app/src/lib/nookal.ts",
                  module: "nookal",
                  lineNo: 57,
                  colNo: 23,
                  inApp: true,
                  context: [
                    [56, "  const response = await fetch(url);"],
                    [57, "  return JSON.parse(await response.text());"],
                  ],
                  vars: {
                    url: "https://api.nookal.example/v2/slots?practitioner=fixture-practitioner&api_key=nookal-var-key-fixture",
                  },
                },
                {
                  function: "JSON.parse",
                  filename: "<anonymous>",
                  absPath: "<anonymous>",
                  module: null,
                  lineNo: null,
                  colNo: null,
                  inApp: false,
                  context: [],
                  vars: null,
                },
              ],
              framesOmitted: null,
              registers: null,
              hasSystemFrames: true,
            },
          },
          {
            type: "Error",
            value: "Couldn't load the booking slots",
            module: null,
            threadId: null,
            mechanism: { type: "auto.http.astro", handled: false, exception_id: 0 },
            stacktrace: {
              frames: [
                {
                  function: "processTicksAndRejections",
                  filename: "node:internal/process/task_queues",
                  absPath: "node:internal/process/task_queues",
                  module: "task_queues",
                  lineNo: 105,
                  colNo: 5,
                  inApp: false,
                  context: [],
                  vars: null,
                },
                {
                  function: "renderEndpoint",
                  filename: "/app/node_modules/astro/dist/core/endpoint/index.js",
                  absPath: "/app/node_modules/astro/dist/core/endpoint/index.js",
                  module: "astro.dist.core.endpoint:index",
                  lineNo: 39,
                  colNo: 20,
                  inApp: false,
                  context: [[39, "    response = await mod[method](context);"]],
                  vars: null,
                },
                {
                  function: "POST",
                  filename: "/app/src/pages/api/book.ts",
                  absPath: "/app/src/pages/api/book.ts",
                  module: "pages.api:book",
                  lineNo: 18,
                  colNo: 21,
                  inApp: true,
                  context: [
                    [17, "  const booking = await request.json();"],
                    [18, "  const slots = await loadSlots(booking.practitionerId);"],
                  ],
                  vars: {
                    booking: {
                      name: "Patient Fixture",
                      email: "patient-fixture@example.com",
                      phone: "0491 570 156",
                      dateOfBirth: "1970-01-01",
                      reason: "Fixture symptoms",
                      practitionerId: "fixture-practitioner",
                    },
                  },
                },
                {
                  function: "loadSlots",
                  filename: "/app/src/lib/booking.ts",
                  absPath: "/app/src/lib/booking.ts",
                  module: "booking",
                  lineNo: 42,
                  colNo: 11,
                  inApp: true,
                  context: [[42, "    throw new Error(\"Couldn't load the booking slots\", { cause });"]],
                  vars: { practitionerId: "fixture-practitioner", cause: "[SyntaxError]" },
                },
              ],
              framesOmitted: null,
              registers: null,
              hasSystemFrames: true,
            },
          },
        ],
        excOmitted: null,
        hasSystemFrames: true,
      },
    },
    {
      type: "breadcrumbs",
      data: {
        values: [
          {
            type: "http",
            category: "fetch",
            level: "info",
            event_id: null,
            timestamp: "2026-11-06T08:41:08.991000Z",
            message: null,
            data: {
              method: "GET",
              url: "https://api.nookal.example/v2/slots?practitioner=fixture-practitioner&api_key=nookal-key-fixture",
              status_code: 502,
            },
          },
          {
            type: "default",
            category: "console",
            level: "log",
            event_id: null,
            timestamp: "2026-11-06T08:41:09.100000Z",
            message: "Booking a slot for breadcrumb-patient-fixture@example.com",
            data: { logger: "console" },
          },
        ],
      },
    },
    {
      type: "request",
      data: {
        url: "https://clinic.example/api/book",
        method: "POST",
        query: [["practitioner", "fixture-practitioner"]],
        fragment: null,
        data: {
          name: "Patient Fixture",
          email: "patient-fixture@example.com",
          phone: "0491 570 156",
          dateOfBirth: "1970-01-01",
          reason: "Request body fixture symptoms",
        },
        cookies: [["session", "session-cookie-fixture"]],
        headers: [
          ["Content-Type", "application/json"],
          ["Cookie", "session=session-cookie-fixture"],
          ["User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"],
        ],
        inferredContentType: "application/json",
      },
    },
  ],
  contexts: {
    booking: { reference: "booking-reference-fixture", clinic: "clinic-fixture" },
    runtime: { name: "node", version: "v22.11.0", type: "runtime" },
    os: { name: "Linux", version: "6.1.0", type: "os" },
    trace: { trace_id: "trace-id-fixture", span_id: "span-id-fixture", op: "http.server", type: "trace" },
  },
  release: {
    version: "clinic@2026.11.05+3f9c2a1",
    shortVersion: "clinic@2026.11.05+3f9c2a1",
    ref: null,
    url: null,
    dateCreated: "2026-11-05T21:02:11.000000Z",
    dateReleased: "2026-11-05T21:04:37.000000Z",
    commitCount: 3,
    deployCount: 1,
    lastDeploy: {
      id: "990001",
      name: "clinic@2026.11.05+3f9c2a1 to production",
      environment: "production",
      url: null,
      dateStarted: null,
      dateFinished: "2026-11-05T21:04:37.000000Z",
    },
    data: {},
  },
  sdk: { name: "sentry.javascript.astro", version: "8.40.0" },
  packages: {},
  fingerprints: ["d41d8cd98f00b204e9800998ecf8427e"],
  previousEventID: "b1e0d9c8a7964e5d8c2b1a0f9e8d7c6b",
  nextEventID: null,
  userReport: null,
  crashFile: null,
  occurrence: null,
};

/**
 * `GET /api/0/organizations/acme/issues/6031244470/events/latest/`: CLINIC-1's
 * latest event, a message the site logged at error level. It has no exception,
 * so no stack frames, and was sent before releases were set up, so no release.
 */
export const CLINIC_1_LATEST_EVENT = {
  id: "a9b8c7d6e5f44a3b9c2d1e0f9a8b7c6d",
  eventID: "a9b8c7d6e5f44a3b9c2d1e0f9a8b7c6d",
  groupID: "6031244470",
  projectID: "4508123000000001",
  title: "Nookal returned no practitioners",
  message: "Nookal returned no practitioners",
  platform: "node",
  type: "default",
  dateCreated: "2026-11-05T12:18:52.031000Z",
  dateReceived: "2026-11-05T12:18:52.420000Z",
  culprit: "",
  location: null,
  dist: null,
  metadata: { title: "Nookal returned no practitioners" },
  tags: [
    { key: "environment", value: "production" },
    { key: "level", value: "error" },
    { key: "server_name", value: "ip-10-0-1-23.ap-southeast-2.compute.internal" },
  ],
  user: null,
  entries: [
    { type: "message", data: { formatted: "Nookal returned no practitioners", params: [] } },
    {
      type: "breadcrumbs",
      data: {
        values: [
          {
            type: "http",
            category: "fetch",
            level: "info",
            event_id: null,
            timestamp: "2026-11-05T12:18:51.870000Z",
            message: null,
            data: { method: "GET", url: "https://api.nookal.example/v2/practitioners?api_key=nookal-key-fixture", status_code: 200 },
          },
        ],
      },
    },
  ],
  contexts: {
    runtime: { name: "node", version: "v22.11.0", type: "runtime" },
    trace: { trace_id: "trace-id-fixture", span_id: "span-id-fixture", op: "default", type: "trace" },
  },
  release: null,
  sdk: { name: "sentry.javascript.astro", version: "8.40.0" },
  packages: {},
  fingerprints: ["{{ default }}"],
  previousEventID: null,
  nextEventID: null,
  userReport: null,
  crashFile: null,
  occurrence: null,
};
