// The Retro evidence action's program (.github/actions/gather-retro-evidence),
// the first job of a Retro run (#151). Like the push job it runs no agent and
// no Product code, and it holds no write credential. It refuses a store that
// isn't private, reads this Product repo's Run records, score files and
// transcripts from the store's sparse checkout, gathers the repo's GitHub
// facts, its Retros' history, the proposals they filed on the Kit's repo or a
// Skills source, and the Tickets of the PRs the evidence carries,
// builds the pending Retro's evidence bundle
// (src/kit/retroEvidence.ts) and writes it as RETRO_EVIDENCE_FILE for the
// action to upload, for the Retro job and the push job to read. It writes one
// step-summary line saying what it gathered. Any failure fails the job, and the
// push job fails the Retro as an Infrastructure failure.
//   node src/kit/retro-evidence-main.ts
// Reads two Fabrik App tokens: FABRIK_STORE_TOKEN, with Contents read on the
// store alone, and FABRIK_PRODUCT_TOKEN, read-only on this Product repo.
// FABRIK_STORE_DIR is the store's checkout, FABRIK_APP_SLUG the Fabrik App's
// slug, which tells its Retros from anyone else's, and FABRIK_OUT_DIR where the
// bundle goes. The pending Retro is the Actions event's issue.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gatherOpenIssuesOn, gatherRetroFacts, gatherRetroHistory, gatherTickets } from "../github/facts.ts";
import { GitHub, type Repo } from "../github/client.ts";
import { readKitConfigSources } from "../github/snapshot.ts";
import { retroMarksIn } from "../loop/markers.ts";
import { retroWindowEnd } from "../loop/retro.ts";
import { proposalReposBeside } from "../loop/retroLanding.ts";
import { resolveKitConfig } from "./config.ts";
import { type EvidenceBundle, evidenceBundle, evidenceReachOf, evidenceTicketsOf, RETRO_EVIDENCE_FILE } from "./retroEvidence.ts";
import { RUN_STORE_REPO, storeIsPrivate } from "./runStore.ts";
import { readStoreRunRecords, readStoreScoreFiles, readStoreTranscripts } from "./storeCheckout.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

async function report(line: string): Promise<void> {
  console.log(line);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") await appendFile(summary, `### Retro evidence\n\n${line}\n`);
}

async function main(): Promise<string> {
  const [owner, name] = required("GITHUB_REPOSITORY").split("/");
  if (owner === undefined || name === undefined) throw new Error("GITHUB_REPOSITORY is not owner/name");
  const repo: Repo = { owner, name };
  const apiUrl = process.env["GITHUB_API_URL"];
  const payload = JSON.parse(await readFile(required("GITHUB_EVENT_PATH"), "utf8")) as { issue?: { number?: unknown } };
  const retro = payload.issue?.number;
  if (typeof retro !== "number") throw new Error("The Actions event names no issue, so there's no pending Retro to gather evidence for");

  // Records hold Product repos' issues and transcripts their code: a store others can read is never read.
  if (!(await storeIsPrivate(new GitHub(required("FABRIK_STORE_TOKEN"), apiUrl)))) {
    throw new Error(`${RUN_STORE_REPO} isn't private, so the Retro reads nothing from it`);
  }
  const product = new GitHub(required("FABRIK_PRODUCT_TOKEN"), apiUrl);
  const config = resolveKitConfig(await readKitConfigSources(product, repo, required("GITHUB_SHA")));
  if (!config.ok) throw new Error(`The Kit config is invalid: ${config.errors.join("; ")}`);
  const operator = config.config.operator ?? owner;

  // The Retros first: the window they give says how far back the facts must reach.
  const history = await gatherRetroHistory(product, repo, `${required("FABRIK_APP_SLUG")}[bot]`);
  const pending = history.retros.find((issue) => issue.number === retro);
  if (pending === undefined) throw new Error(`#${retro} isn't among the repo's newest fabrik:retro issues`);
  const windowEnd = retroWindowEnd({ createdAt: pending.createdAt, ...retroMarksIn(pending.body) });
  const reach = evidenceReachOf({ retro, windowEnd, retros: history.retros });

  const storeDir = required("FABRIK_STORE_DIR");
  const [records, scoreFiles, readTranscript, facts, elsewhere] = await Promise.all([
    // A schema 1 record, written before runs were given a Subscription, reads as on the first this repo lists.
    readStoreRunRecords(storeDir, config.config.subscriptions).then(({ records }) => records),
    readStoreScoreFiles(storeDir),
    readStoreTranscripts(storeDir),
    gatherRetroFacts(product, repo, Date.now(), operator, reach),
    // Proposals filed on the Kit's repo or an owned Skills source, read with the same read-only token.
    gatherOpenIssuesOn(product, proposalReposBeside(`${owner}/${name}`, operator, config.config)),
  ]);
  // One it can't read costs the Retro only the proposals filed there, which it may then propose again.
  for (const { repo: unread, why } of elsewhere.unread) {
    console.log(`::warning title=Retro evidence::Couldn't read the open issues on ${unread}, so the Retro won't see proposals filed there: ${why}`);
  }

  const input = {
    records: Object.values(records),
    readTranscript,
    scoreFiles,
    facts,
    operator,
    retro,
    windowEnd,
    retros: history.retros,
    fromRetroIssues: [...history.openIssues, ...elsewhere.issues],
  };
  // The facts hold each PR's Ticket by number: the bundle carries the escaped and sampled PRs' as written.
  const tickets = await gatherTickets(product, repo, evidenceTicketsOf(input));
  const bundle = evidenceBundle({ ...input, tickets });
  // Compact, as the budget measures it.
  const text = JSON.stringify(bundle);
  const outDir = required("FABRIK_OUT_DIR");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, RETRO_EVIDENCE_FILE), text);
  return gathered(retro, bundle, text.length);
}

/** What the bundle holds, in one line. */
function gathered(retro: number, bundle: EvidenceBundle, characters: number): string {
  const counts = [
    `${bundle.escapes.length} escape(s)`,
    `Operator feedback on ${bundle.feedback.length} PR(s)`,
    `${bundle.followUps.length} PR(s) with Follow-ups`,
    `${bundle.lowScores.length} low-scoring run(s)`,
    `${bundle.sample.length} sampled PR(s)`,
    `${bundle.streakTable.length} PR(s) in the streak table`,
  ];
  const size = `${characters.toLocaleString("en")} characters${bundle.trimmed ? ", cut to fit its budget" : ""}`;
  return `Gathered the evidence for Retro #${retro}, from ${bundle.window.start} to ${bundle.window.end}: ${counts.join(", ")}, in ${size}.`;
}

main()
  .then(report)
  .catch((error: unknown) => {
    console.log(`::error title=Retro evidence::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
