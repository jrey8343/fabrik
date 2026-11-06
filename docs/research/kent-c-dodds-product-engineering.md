# Kent C. Dodds' product-engineering material: what it is and where it lives

Research for [#65](https://github.com/jrey8343/fabrik/issues/65), on the Map [#62](https://github.com/jrey8343/fabrik/issues/62). It answers: what is Kent C. Dodds' product-engineering material, where does it live, are there transcripts, what terms apply to mining them, and which of its principles bear on Fabrik's product gate.

Researched 2026-11-04. Every source is first-party (Kent's own sites, feeds and GitHub repos), unless marked otherwise. Third-party summaries turned up in search (stork.ai, biggo.com, and so on) and were not relied on.

## TL;DR

- **The material is a brand: "Epic Product Engineer"** at [epicproduct.engineer](https://www.epicproduct.engineer). Kent calls it his "next chapter: courses, cohorts, live events, and articles", and [kentcdodds.com/courses](https://kentcdodds.com/courses) lists it as "Current focus: product engineering."
- **No self-paced course exists yet.** The home page says "Subscribe to get notified when the course launches."
- **What exists today:**
  1. One essay, *The Last Software Engineer* (2026-04-27). This is the closest thing to a definition and a checklist.
  2. A weekly interview podcast, *Become an Epic Product Engineer*, with 33 episodes (2026-03-31 to 2026-10-28). It started as Season 7 of *Chats with Kent* and became its own show.
  3. A solo video/podcast series, *Better with Kent*, with 31 episodes (2026-05-22 to 2026-11-03). It covers the same "durable skills" and teaches named frameworks (Jobs to Be Done, Kano, and others).
  4. Paid live workshops: two online "Product Engineering Workshop" cohorts (2026-07-07 and 2026-08-25), and an "AI-Native Product Engineering" conference workshop (2026-11-18, NYC, via GitNation / AI Coding Summit).
- **Transcripts: yes, and easy to fetch.**
  - Both podcast feeds (on Transistor) carry a `<podcast:transcript>` plain-text file for every episode: 33 of 33 and 31 of 31. They have speaker labels and timestamps.
  - The Chats with Kent Season 7 pages on kentcdodds.com also show full transcripts inline.
  - Workshop recordings and transcripts are not public.
- **Terms: all rights reserved, with no licence to mine.**
  - Both feeds say "© 2026 Kent C. Dodds Tech LLC". The Become an Epic Product Engineer feed adds "All rights reserved."
  - epicproduct.engineer's terms are those of Skill Recordings Inc. They forbid using the service "to spam, phish, pharm, pretext, spider, crawl, or scrape". They also forbid anyone to "reproduce, duplicate, copy, sell, resell or exploit any portion of the Service ... without express written permission".
  - The kentcdodds.com repo licenses its material for "private, non-commercial use" (GPL v3 named), and asks people to contact Kent for any other use.
  - **Practical reading:** the Operator may fetch the published transcripts and read them, or have an agent read them, to distil principles in their own words, with attribution. Do not commit verbatim transcripts or long quotations to a repo, and do not crawl epicproduct.engineer. To redistribute any text, ask Kent first (me@kentcdodds.com, or [epicproduct.engineer/contact](https://www.epicproduct.engineer/contact)). This is a reading of the terms, not legal advice.
- **Bonus: one source is directly reusable.** [`kentcdodds/kcd-skills`](https://github.com/kentcdodds/kcd-skills) is MIT-licensed, and Kent's personal agent skills are in it. They come from his "personal software factory" Kody. Its `autopilot` and `review-and-recommend` skills encode several of the same product-gate ideas. Fabrik could pin it as a skills source, with no licence question.

## 1. Where it lives

| What | Where | Status / access |
|---|---|---|
| Hub site | [epicproduct.engineer](https://www.epicproduct.engineer) (operated by Skill Recordings Inc., per its [terms page](https://www.epicproduct.engineer/privacy)) | Live; free; email sign-up. The course is "coming"; no price shown. |
| Essay | [The Last Software Engineer](https://www.epicproduct.engineer/the-last-software-engineer), 2026-04-27 | Free, public. The only "article" in the site's [Learn/browse](https://www.epicproduct.engineer/browse) section. |
| Interview podcast | *Become an Epic Product Engineer*: [show page](https://www.epicproduct.engineer/become-an-epic-product-engineer-podcast), feed `https://feeds.transistor.fm/become-an-epic-product-engineer`, [Apple Podcasts](https://podcasts.apple.com/us/podcast/id1896782497) | Free, weekly, 33 episodes. Episode pages carry show notes, "Homework" and resources, plus a Mux-hosted video. |
| Earlier home of the same episodes | *Chats with Kent* Season 7, [kentcdodds.com/chats/07](https://kentcdodds.com/chats/07), 12 episodes (00 to 11), 2026-04-01 to 2026-05-27 | Free. Each page has an inline "Transcript" section. The [finale](https://kentcdodds.com/chats/07/11/season-7-finale-become-a-product-engineer-is-now-its-own-podcast) says: "Become a Product Engineer has graduated from just a season of Chats with Kent into its own podcast." |
| Solo series | *Better with Kent*: [kentcdodds.com/better](https://kentcdodds.com/better), feed `https://feeds.transistor.fm/better-with-kent`, [Apple Podcasts](https://podcasts.apple.com/podcast/better-with-kent/id1896798447) | Free, 31 episodes. The feed describes it as "Solo episodes ... on durable skills for people who ship software: judgment, accountability, problem clarity". |
| Online cohort workshops | [Product Engineering Workshop (2026-07)](https://www.epicproduct.engineer/events/product-engineering-workshop-2026-07) and [(2026-08)](https://www.epicproduct.engineer/events/product-engineering-workshop-2026-08-y744m) | Paid live events, 8:00 AM to 2:00 PM Pacific. Both dates have passed. No recording is offered publicly. |
| Conference workshop | "AI-Native Product Engineering", [GitNation listing](https://gitnation.com/contents/ai-native-product-engineering-3752), 2026-11-18, NYC (AI Coding Summit). Previously given at JSNation US 2026 and React Summit US 2026. | Paid workshop ticket. The listing mentions no recording or transcript. |
| Agent skills | [`kentcdodds/kcd-skills`](https://github.com/kentcdodds/kcd-skills) (created 2026-07-09, active) | **MIT.** Skills: `autopilot`, `review-and-recommend`, `visual-recap`, `ship-pr`, `friction-log`, `use-kody`, `prefer-local-kody-execute`. |
| Blog source | [`kentcdodds/kentcdodds.com`](https://github.com/kentcdodds/kentcdodds.com), `services/site/content/blog/` (217 posts, including "Introducing Kody: your personal software factory") | `LICENSE.md`: private, non-commercial use only. |

**Not found:**

- A self-paced course, any paid course content, or a written curriculum beyond the workshop pages.
- A public recording of any workshop.
- The "AI Engineer: Build the Right Thing" talk. Third-party aggregators list it, but no first-party upload was found, so it is unconfirmed.
- Any transcript on the epicproduct.engineer episode pages: the page data has `"transcript":null`. The transcripts live in the Transistor feed instead.

## 2. Transcripts: form and how to get them

- **Become an Epic Product Engineer** (33 episodes) and **Better with Kent** (31 episodes): every `<item>` in the Transistor RSS feed has `<podcast:transcript url="https://share.transistor.fm/s/<id>/transcript.txt" type="text/plain"/>`.
  - The format is plain text, in speaker-labelled turns with timestamps, for example `Kent C. Dodds (00:00.972)` followed by the utterance.
  - One sample (Drew Hoskins, about 50 minutes) is 47 KB.
  - Only text/plain is offered; there is no VTT, SRT or JSON variant.
  - Show notes (summary, chapters, homework, links) are in each item's `<description>`.
- **Chats with Kent S7** (the first 12 product-engineering episodes, in both places): the transcripts are inline on the kentcdodds.com episode pages, in the same `Name (mm:ss.mmm)` format. The Simplecast feed (`feeds.simplecast.com/X_wS_WYh`) carries **no** transcript tags. The same episodes are also in the Become an Epic Product Engineer feed, with transcripts, so use that feed.
- **The essay** is plain HTML on epicproduct.engineer.
- Full episode tables with transcript links are in the appendix.

**The cheapest way to mine it:**

1. Fetch the two RSS feeds, a total of 2 requests.
2. Pull the 64 `transcript.txt` URLs they list.

Nothing needs crawling, and these are the feed URLs Kent publishes for podcast apps.

## 3. Terms that apply

| Source | Terms found |
|---|---|
| Become an Epic Product Engineer feed | `<copyright>© 2026 Kent C. Dodds Tech LLC. All rights reserved.</copyright>` |
| Better with Kent feed | `<copyright>© 2026 Kent C. Dodds Tech LLC</copyright>` |
| epicproduct.engineer site ([terms page](https://www.epicproduct.engineer/privacy), "Terms, Conditions, and Privacy Policy", operated by Skill Recordings Inc.) | The service may not be used "(i) to spam, phish, pharm, pretext, spider, crawl, or scrape". Users must not "reproduce, duplicate, copy, sell, resell or exploit any portion of the Service ... without express written permission by us." |
| epicproduct.engineer [RSS](https://www.epicproduct.engineer/rss.xml) | `Copyright © 2026 Kent C. Dodds` |
| kentcdodds.com repo `LICENSE.md` | "This material is available for private, non-commercial use under the GPL version 3. If you would like to use this material to conduct your own workshop, please contact me at me@kentcdodds.com" |
| kcd-skills | MIT. The README adds: "You are welcome to fork this repository, use it as inspiration, or install and modify the skills for your own workflows." |

**What this means for the Operator's plan** (Kent-derived skills in their own skills repo; the Map treats that as out of scope, and this note only covers the sources):

- Reading the transcripts is what the feeds are for. A private agent pass that distils *ideas* is the low-risk path. Ideas and frameworks (JTBD, Kano, the Mom Test) are not copyrightable, and most are not Kent's anyway. Paraphrase, and credit "after Kent C. Dodds, *The Last Software Engineer*".
- Don't commit the transcripts, the essay, or long verbatim passages to a public repo. Don't build a crawler against epicproduct.engineer.
- To ship Kent's wording, or a skill closely derived from it, ask Kent at me@kentcdodds.com.
- The kcd-skills content can be pinned or forked as is, under MIT.

## 4. Principles that bear on Fabrik's product gate

Kent's own definition, from the essay: "Product engineering is the discipline of connecting implementation decisions to product consequences."

His checklist, verbatim from the same essay, is the part closest to a gate: "In practice, product engineering means asking what user problem the task is really solving, defining success before implementation, naming the constraints that must not be violated, identifying who could be harmed or confused by the change, distinguishing measurable improvement from real improvement, and planning rollout and rollback before shipping."

The gate's four questions, matched to his material:

**Which user this serves**

- Jobs to Be Done, from Better with Kent, "Stop Taking Tickets, Start Applying Jobs Theory":
  - Ask "What job is this for?" before the estimate, the PRD or the agent prompt.
  - "A ticket is not a job."
  - Write a one-sentence job statement in the form *When [circumstance], help us [progress], without [current pain]*.
- The essay adds: identify "who could be harmed or confused by the change", and which "users are allowed to absorb the experiment".
- Teresa Torres episode homework: ask a real customer about "the last time they experienced the problem your product solves - not about your product" (the Mom Test).

**Why it exists**

- Three questions before you estimate (same episode):
  1. Progress and circumstance.
  2. What they hire today (the workaround).
  3. What "fired" looks like.
- The essay asks "whether the target should exist, whether hitting it would damage something else, whether there is a better target nearby".
- The workshop pages name the skills: problem clarity, systems thinking, and pushing back on "upstream requests that should not be implemented".

**How success is measured**

- "Defining success before implementation."
- "Distinguishing measurable improvement from real improvement."
- "Measurement does not remove judgment. Someone still has to decide which outcomes matter, which metrics are proxies ... and what costs are unacceptable even if the numbers improve."
- The JTBD episode adds: after you ship, separate the "little hire" from the "big hire", because metrics alone miss the emotional job, so stack qualitative signal on top.
- Build-Measure-Learn feedback loops (workshop syllabus).

**What we are deliberately not doing**

- From the essay:
  - "Naming the constraints that must not be violated."
  - "What damage would make success meaningless."
  - "Sometimes a solution is technically elegant and still wrong because it changes the product's promise to the user."
- Kano model ("How to Prioritize Software Tasks"): you "cannot delight your way out of broken basics". Classify each item as Must-be, Performance or Delighter before ordering the backlog.
- kcd-skills `autopilot`: "Write down the 'no': decisions agents would otherwise re-propose."
- kcd-skills `review-and-recommend`: present options with effort and a **one-way or two-way door** label, recommend one, then stop and wait for the human's choice.
- Plan "rollout and rollback before shipping".

**The cross-cutting principle that fits the Operator model**

- Accountability. Agents "can give you options ... and recommend what you *could* do next. But what you *should* do next is harder to delegate", because "a system that does not bear the cost of being wrong can recommend a locally optimal choice that no responsible owner should accept". Someone has to say: "This is the future we are going to ship."
- `autopilot` frames it as "Agents ship most changes; the human owns product decisions."
- In Fabrik's terms: the product gate is a HITL step that belongs to the Operator. Agents gather evidence and options for it; they do not decide it.

**Directly relevant to Fabrik's framing**

- The Better with Kent episode "What the devil is a Factory Engineer?!" (2026-07-07) is Kent reacting to Zach Lloyd's Warp memo, which the Map lists as a source.
- He agrees with "build the system agents work in, measure throughput, tighten the loop". He "pushes back on anything that treats the product as optional": "Internal tools still have users. Factory efficiency only matters when the right work goes in."
- This is a ready-made argument for putting a product gate in front of the factory.

## Appendix: episodes and transcript URLs

Taken from the two Transistor feeds on 2026-11-04. The dates are feed `pubDate`s.

### Become an Epic Product Engineer (33)

| Date | Episode | Transcript |
|---|---|---|
| 2026-03-31 | Foundations, feedback, and agents — Dillon Mulroy on product at Cloudflare | [txt](https://share.transistor.fm/s/1620847b/transcript.txt) |
| 2026-03-31 | Introducing Become an Epic Product Engineer | [txt](https://share.transistor.fm/s/7365f52e/transcript.txt) |
| 2026-03-31 | Product sense, restraint, and OpenCode with Dax Raad | [txt](https://share.transistor.fm/s/4cd72d4d/transcript.txt) |
| 2026-03-31 | The right thing before the thing right — product engineering with Wayne Allan | [txt](https://share.transistor.fm/s/9961290d/transcript.txt) |
| 2026-04-08 | Vertical slices, Solo, and empathy — product engineering with Aaron D. Francis | [txt](https://share.transistor.fm/s/b2ee4f3a/transcript.txt) |
| 2026-04-15 | Human factors, product debt, and industrial design — product engineering with Will King | [txt](https://share.transistor.fm/s/5c344b89/transcript.txt) |
| 2026-04-22 | Watch users, fix systems, and design for humanity — product engineering with Don Norman | [txt](https://share.transistor.fm/s/25a74dcb/transcript.txt) |
| 2026-04-29 | Stakeholder empathy, UX, and durable product skills — product engineering with Jamon Holmgren | [txt](https://share.transistor.fm/s/b7e51b7d/transcript.txt) |
| 2026-05-06 | Speed, prioritization, and maintainability — product engineering with Julius Marminge | [txt](https://share.transistor.fm/s/d9776a37/transcript.txt) |
| 2026-05-13 | Customer research, desire, and Sales Safari - product engineering with Alex Hillman | [txt](https://share.transistor.fm/s/61863985/transcript.txt) |
| 2026-05-20 | Primitives, agent UX, and Executor - product engineering with Rhys Sullivan | [txt](https://share.transistor.fm/s/64cdbfd9/transcript.txt) |
| 2026-05-27 | User empathy, feedback loops, and what not to build - product engineering with Jack Ryan | [txt](https://share.transistor.fm/s/ef80b659/transcript.txt) |
| 2026-06-03 | User outcomes, workflow design, and biotech software - product engineering with Swizec Teller | [txt](https://share.transistor.fm/s/fabf2b37/transcript.txt) |
| 2026-06-10 | Software architecture, human judgment, and AI's limits with Grady Booch | [txt](https://share.transistor.fm/s/454b2b2a/transcript.txt) |
| 2026-06-17 | The technical person in the room - product engineering with Sean Roberts | [txt](https://share.transistor.fm/s/3befb0d2/transcript.txt) |
| 2026-06-24 | Demos, feedback loops, and AI-era product judgment with Ruben Casas | [txt](https://share.transistor.fm/s/7fa9a04b/transcript.txt) |
| 2026-07-01 | Know your customer better than your code - product engineering with Lucas Wargha | [txt](https://share.transistor.fm/s/a0a901cb/transcript.txt) |
| 2026-07-08 | Taste, simplicity, and AI-era product judgment with Michael Shimeles | [txt](https://share.transistor.fm/s/d951a4e6/transcript.txt) |
| 2026-07-15 | Curiosity, UX, and durable engineering skills with Annie Sexton | [txt](https://share.transistor.fm/s/0186f089/transcript.txt) |
| 2026-07-22 | Architecture, AI agents, and product empathy with Robert C. Martin | [txt](https://share.transistor.fm/s/7f2974b4/transcript.txt) |
| 2026-07-29 | Developer customers, AI skills, and durable product judgment with Ben Ilegbodu | [txt](https://share.transistor.fm/s/f0efe95e/transcript.txt) |
| 2026-08-05 | Write it down: process, benchmarking, and product judgment with Ronan Berder | [txt](https://share.transistor.fm/s/0c56c05a/transcript.txt) |
| 2026-08-12 | Talk to users, ship live demos, and build durable products with Michael Grinich | [txt](https://share.transistor.fm/s/fdb3b23b/transcript.txt) |
| 2026-08-19 | Curiosity, micro-sales, and AI as a supplement with Shaundai Person | [txt](https://share.transistor.fm/s/49fe230d/transcript.txt) |
| 2026-09-02 | AI is a tool, not a silver bullet - product discovery with Peppe Silletti | [txt](https://share.transistor.fm/s/e1e626a1/transcript.txt) |
| 2026-09-09 | Ask why in every PR - product engineering with Erin Fox | [txt](https://share.transistor.fm/s/3516e64a/transcript.txt) |
| 2026-09-16 | Use the product yourself - empathy, architecture, and PM partnership with Rita Kozlov | [txt](https://share.transistor.fm/s/b88a5f67/transcript.txt) |
| 2026-09-23 | Keep a friction log and read a sales book - product ownership with Joyce Er | [txt](https://share.transistor.fm/s/334c3d5e/transcript.txt) |
| 2026-09-30 | Lead with empathy and listen without defense - product sense with Mark Techson | [txt](https://share.transistor.fm/s/dd01313f/transcript.txt) |
| 2026-10-07 | Start with curiosity and talk to a customer - continuous discovery with Teresa Torres | [txt](https://share.transistor.fm/s/1e20d5b2/transcript.txt) |
| 2026-10-14 | Get five people talking about your product - iterative feedback with Ben Vinegar | [txt](https://share.transistor.fm/s/0acd06b7/transcript.txt) |
| 2026-10-21 | Triage your backlog with LNO - product-minded engineering with Sam Julien | [txt](https://share.transistor.fm/s/9f376d93/transcript.txt) |
| 2026-10-28 | Sketch the user journey and review systems - product-minded engineering with Drew Hoskins | [txt](https://share.transistor.fm/s/7f5e9c41/transcript.txt) |

### Better with Kent (31)

| Date | Episode | Transcript |
|---|---|---|
| 2026-05-22 | Introducing Better with Kent | [txt](https://share.transistor.fm/s/39c16504/transcript.txt) |
| 2026-05-29 | What Software Engineers Need in 2026 | [txt](https://share.transistor.fm/s/8db60551/transcript.txt) |
| 2026-06-03 | How to Prioritize Software Tasks | [txt](https://share.transistor.fm/s/c0c3ff8b/transcript.txt) |
| 2026-06-12 | How an AI Agent Deleted PocketOS Production in 9 Seconds | [txt](https://share.transistor.fm/s/346e3014/transcript.txt) |
| 2026-06-16 | Stop Taking Tickets, Start Applying Jobs Theory | [txt](https://share.transistor.fm/s/6ea8bbee/transcript.txt) |
| 2026-06-23 | Pragmatic Loop Engineering for AI Coding Agents | [txt](https://share.transistor.fm/s/fa2b6ada/transcript.txt) |
| 2026-06-30 | I built my own OpenClaw | [txt](https://share.transistor.fm/s/e2720533/transcript.txt) |
| 2026-07-02 | I got attacked! - How I used my AI agent to fight back! | [txt](https://share.transistor.fm/s/7ad2b507/transcript.txt) |
| 2026-07-07 | What the devil is a Factory Engineer?! | [txt](https://share.transistor.fm/s/ad178f92/transcript.txt) |
| 2026-07-09 | The Framework wars are over. Why no one dethroned React | [txt](https://share.transistor.fm/s/3a85855d/transcript.txt) |
| 2026-07-15 | Your Coding Agent Needs Better Primitives | [txt](https://share.transistor.fm/s/fefe75df/transcript.txt) |
| 2026-07-21 | Fable nailed my production YOLO infra migration | [txt](https://share.transistor.fm/s/90349326/transcript.txt) |
| 2026-07-23 | My Agent Ships Across 6 Services Without Seeing a Secret | [txt](https://share.transistor.fm/s/6d9c14fb/transcript.txt) |
| 2026-07-28 | Stop Reviewing Diffs. Start Reviewing Systems. | [txt](https://share.transistor.fm/s/cd9a47b5/transcript.txt) |
| 2026-07-30 | Forget "read the code," I don't even merge PRs myself | [txt](https://share.transistor.fm/s/b8fc5642/transcript.txt) |
| 2026-08-04 | I Delete Tests Every Night (On Purpose) | [txt](https://share.transistor.fm/s/78212e5c/transcript.txt) |
| 2026-08-06 | How to increase your leverage with agents | [txt](https://share.transistor.fm/s/fa1fa23a/transcript.txt) |
| 2026-08-11 | Use AI to make product decisions | [txt](https://share.transistor.fm/s/b8bf8261/transcript.txt) |
| 2026-08-13 | Stop Burning Your Context Cash | [txt](https://share.transistor.fm/s/653792ae/transcript.txt) |
| 2026-08-18 | The craft "dying" is your OPPORTUNITY | [txt](https://share.transistor.fm/s/baefc2f3/transcript.txt) |
| 2026-08-20 | Here's how the new MCP spec works | [txt](https://share.transistor.fm/s/bb13e2fd/transcript.txt) |
| 2026-08-25 | Turn your agent on auto-pilot with ADRs | [txt](https://share.transistor.fm/s/a0fa1078/transcript.txt) |
| 2026-08-27 | How Kody Gives Your Agents a Shared Home | [txt](https://share.transistor.fm/s/decca4e7/transcript.txt) |
| 2026-09-08 | Introducing Kody: Your Personal Software Factory | [txt](https://share.transistor.fm/s/20c64c80/transcript.txt) |
| 2026-09-15 | Make your agent safe and autonomous | [txt](https://share.transistor.fm/s/0067dafd/transcript.txt) |
| 2026-09-25 | Build a Software Pipeline: Help your agent help you | [txt](https://share.transistor.fm/s/7637fa39/transcript.txt) |
| 2026-10-06 | Steal My App (I'll Show You How) | [txt](https://share.transistor.fm/s/10d8e536/transcript.txt) |
| 2026-10-13 | How to Put Your Codebase on Autopilot | [txt](https://share.transistor.fm/s/b8004c3b/transcript.txt) |
| 2026-10-20 | The Future of Software is Invisible | [txt](https://share.transistor.fm/s/476bd1c4/transcript.txt) |
| 2026-10-27 | My AI Employees Won't Let Me Sleep | [txt](https://share.transistor.fm/s/833ee356/transcript.txt) |
| 2026-11-03 | How I'd Get Into Software in 2026 | [txt](https://share.transistor.fm/s/e64e3d02/transcript.txt) |
