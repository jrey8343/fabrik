# Jev (TypeSafe AI): API, pricing and data terms

Research for Decision [#345](https://github.com/jrey8343/fabrik/issues/345) on the Map [#344](https://github.com/jrey8343/fabrik/issues/344) (Wayfinder: Quick calls with Jev in the Loop). All sources were read on 2026-11-08. At that date the current model was `jev-1.14.0`, and `jev-latest` pointed to it.

**Method.** I read TypeSafe's own pages: the docs (`docs.typesafe.ai`, including the OpenAPI spec embedded in the API reference), the legal pages, the help centre (`help.typesafe.ai`), the status page, the evals site and the company blog. I used press only where those pages are silent, and say so when I do. No account was created, no API key was used, and no request was sent to Jev. This file reports facts and decides nothing for Fabrik.

**Marking.** **(vendor)** marks a number that only TypeSafe states, with no independent check. **(press)** marks a fact that comes only from launch coverage. **(aggregator, low quality)** marks a claim found only on SEO or funding-aggregator sites.

## Answer in brief

- **What it is.** Jev is a hosted HTTP API. You send it one `state` (text, JSON, or PNG/JPEG images) and a set of named, typed questions. It returns typed answers with probabilities. It does not generate text, call tools, read files or hold a conversation. [D-coding-agents]
- **Confidence.** Every Choice and Score answer carries per-option `probabilities` and a `confidence` number derived from them by a published formula. A Noul answer is a single probability. TypeSafe says the model is *trained* for calibration (RLCD), but **publishes no calibration measurement**: no reliability diagram, no ECE, no Brier score. [D-confidence] [D-primer]
- **Learning.** **None per customer.** There is no fine-tuning, no LoRA, no feedback endpoint and no labelled-example API, and every account is served the same weights. Domain knowledge goes into `state`, `instructions` and `criteria` on each request, and is billed as input tokens. [D-models]
- **Price.** **$0.042 per million input tokens, and output is free (vendor).** Billing is prepaid, non-refundable credits that expire after 12 months. Auto-recharge is opt-in. With it off, an empty balance returns HTTP `402`, so the balance is a hard spend cap. There is **no free tier or trial credit**. [D-models] [H-credits] [H-402] [MCA §8.2]
- **Availability.** It launched 15 Sep 2026 in "early access" with a waitlist. The help centre now says sign-ups need no waitlist approval. There is **no SLA**: the MCA promises "as is / as available" service only. There is a public status page. Processing is **US-only**. [B-launch] [H-signup] [MCA §9.3] [Status]
- **Data.** TypeSafe does not train on inputs or outputs, and there is a DPA. But **there is no fixed retention period** unless you turn on zero data retention (ZDR). The MCA grants TypeSafe a **perpetual** licence to use Customer Data for telemetry, abuse monitoring and legal compliance. **There is no HIPAA support and TypeSafe signs no BAA.** Nothing in its documents mentions Australian privacy law. [MCA §4.1] [H-retained] [H-baa]
- **Vendor.** It raised a $40M seed (led by DCVC, 15 Sep 2026, per press) and then, on 9 Oct 2026, **a Series A of $870M at a $7.5B valuation led by a16z, which TypeSafe confirms on its own blog**. The two figures in the issue are therefore two rounds, not a conflict. There is no formal deprecation policy yet; TypeSafe has stated an intent to give 60 days' notice for `jev-1.13.0` and 30 days for `jev-1.14.0`. [B-seriesA] [B-1.14]

## 1. Interface

### HTTP shape

- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone`, with `Authorization: Bearer <key>`. Keys come from `console.typesafe.ai/keys`. The OpenAPI spec is at `https://api.typesafe.ai/openapi.json` (spec version `0.2.0`). `GET /v1/models` lists the model aliases. [D-api] [D-quickstart]
- **Request body** (JSON, or `multipart/form-data` when images are sent as parts): `model` (required), `state` (required, a string, object or array), `questions` (required, an object of named questions, at least one), and `assets` (optional, images keyed by placeholder strings). [D-api]
- **Response body:** `model` (the versioned ID that answered), `answers` (keyed by your question names, each typed to match its question), and `usage.input_tokens` / `usage.output_tokens`. The spec says "Output tokens are currently free of charge." [D-api]
- **Errors:** `400` (rule broken, or `max_tokens_exceeded`), `401`, `402` (out of credits, per the help centre; it is not listed in the docs' error table), `413` (over 32 MiB), `415`, `422` (validation), `429` (rate limit), and `529` (overloaded). The SDKs retry `429` and `529` with backoff and honour `retry-after`. [D-errors] [H-402]

### How a decision schema is defined

There are four question types. Each question has `instructions` (what to decide) and, for most types, `criteria`. [D-intro] [D-api]

| Type | Defines | Returns | Limits |
|---|---|---|---|
| **Choice** | `criteria`: an object of option name → description of when it applies | `choice` (the top option), `probabilities` per option, `confidence` | 1 to **255** options (`maxProperties: 255`) |
| **Score** | `criteria`: an ordered array of level descriptions; position = score, starting at 0 | `score` (the probability-weighted mean, which can fall between levels), `probabilities` per level, `legend`, `confidence` | 1 to **10** levels (`maxItems: 10`) |
| **Noul** | a yes/no `instructions`, with optional `criteria` for what counts as true/false | `noul`: the probability of yes, from 0 to 1. **No `confidence` field** | — |
| **Box** | `instructions`: what to find in an image | `box` (`top`, `bottom`, `left`, `right` as fractions); `confidence` is `null` in the spec example | `jev-1.14.0` only; requires the images header |

- **Enums:** Choice is the enum type. It cannot answer outside the list you give it ("it can't invent a category outside that list, but it can choose the wrong one"). [Home FAQ]
- **Multi-label:** there is **no multi-label type**. Choice picks exactly one option. The documented pattern is one Noul per label, asked in the same request. The docs' counting example asks one Noul per item and sums the results in code. The "Companion Noul" pattern pairs a Choice with a Noul that asks whether any option fits at all. [D-jaggedness] [D-llms index: Companion Noul]
- **Structured fields:** `state`, `instructions` and `criteria` each accept a string, a JSON object or an array, nested up to 64 levels. [D-advanced] [D-errors]
- **Many questions per request:** questions are evaluated "in parallel and independently against the same state". There is no cap on how many questions a request may carry; the only limits are the context limits below. [D-models] [D-state]
- **Extraction and generation:** Jev does not generate values. TypeSafe advises extracting candidate values with a regex or a generative model, then asking a Choice to pick among them. [D-jaggedness]

### What input it takes, and how much

- **Text and JSON**, plus **PNG/JPEG images** placed in `state`, `instructions` or `criteria` through `assets`. Images require the `TypeSafe-Danger-Zone-Images: true` header. The 1.14 launch post says danger-zone features have "way too much jaggedness for us to vouch for these for production use cases". **No audio or video.** [D-models] [B-1.14]
- **Default context limits:** 64k tokens per request (the state plus all questions) and 32k tokens per question (the state plus any one question). [D-models]
- **Long context:** the `TypeSafe-Danger-Zone-Long-Context: true` header raises both limits to **262k tokens**, at the same price per token. TypeSafe says it is "slower and less accurate". [D-models]
- **Body limits:** at most 32 MiB, compressed or not (gzip or zstd allowed); UTF-8 JSON with no BOM; finite numbers only. [D-errors]

### Files and tools

**No.** Jev has no file reading, tool calling, browsing or code execution. The docs say coding agents "stream text, call tools, and edit files… Jev does none of that". Whatever Jev should see has to be put into `state` by the caller. [D-coding-agents]

### SDKs and other routes

- **Python:** `pip install typesafe-sdk`, with sync `TypeSafeClient` and async `AsyncTypeSafeClient`. It reads `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`) and `TYPESAFE_DEFAULT_MODEL` (default `jev-latest`). The default timeout is 10 s per HTTP operation. Retries are configurable. [D-sdk-python] [D-sdk-constants]
- **JavaScript/TypeScript:** `npm install @typesafe-ai/sdk`, which needs Node.js 22 or newer. Its default per-attempt timeout is 10,000 ms. [D-sdk-js] [D-llms-full]
- **Through gateways:** the SDK docs show OpenRouter (`openrouter.ai/~typesafe/jev-latest`) and the Vercel AI Gateway (`ai-gateway.vercel.sh/typesafe`) as alternative base URLs. [D-llms-full] (A Cloudflare Workers AI route appears only in a search-engine summary and was not confirmed on any TypeSafe page.)
- **Not available** on Amazon Bedrock, Google Vertex AI or Azure Foundry ("Not currently, but we hope to be soon"). It cannot be self-hosted, in a VPC or on-premises ("No. Jev is currently available only through our hosted API."). [H-bedrock] [Enterprise FAQ]

### Known weak spots (TypeSafe's own list)

TypeSafe publishes a "Model jaggedness" page. [D-jaggedness] Its entries:

- **Literal reading.** "Jev answers the question you wrote, not the one you meant."
- **Arithmetic, counting, and comparing dates.** These belong in code.
- **Multi-hop indirection.**
- **Accuracy falls as `state` fills with irrelevant detail** ("context rot").
- **Adversarial content in `state` "can move the answer".** Jev "does not treat it as hostile by default".
- **Choice option order bias.** "Jev leans toward the option that comes first."
- **Score levels are "weak in numerical calibration".** Don't interpolate between levels.

## 2. Confidence

- **What the numbers are.** `probabilities` is a distribution over a Choice's options or a Score's levels, and sums to about 1. `confidence` is computed from that distribution: [D-confidence]
  - **Choice:** `(p_max − 1/n) / (1 − 1/n)`, so an even split gives 0 and certainty gives 1. With a fixed number of options it is only a transform of the top probability.
  - **Score:** 1 minus the probability-weighted distance from the most likely level, divided by that same distance for a uniform spread, floored at 0. Probability on a neighbouring level costs less confidence than probability on a far one.
  - **Noul:** no `confidence` field. The value itself is P(yes). The docs suggest starting thresholds of 0.7 for yes and 0.3 for no, with the band between given its own outcome.
- **What TypeSafe says about calibration.** RLCD trains for "calibrated decisions": "Higher probability should correspond to a greater chance that the answer is correct", with the frequency interpretation (0.8 means right about 80% of the time) applying "across groups of predictions, not a guarantee about any single answer". [D-primer] [D-system-one]
- **What TypeSafe advises.** Put thresholds on the probability of the option your code will act on, not on `confidence`. "The correct threshold values depend on your domain… Start with conservative thresholds, test with your own data, and adjust." [D-confidence]
- **Evidence of calibration: none published.** I found no reliability diagram, ECE, Brier score or log-loss figure in the docs, the launch post or the evals site (`evals.typesafe.ai`). The evals site reports accuracy against a reference built from the average of GPT-6 Astra and Fable 5.1. That is agreement with frontier models, not calibration against ground truth. The Register and VKTR both note that the calibration claim comes with no metrics. TechCrunch quotes a user who says Jev "delegates the hallucination problem a little bit to the user". [Evals] [press]
- **Determinism.** It is not promised. "Jev is designed for consistency", meaning similar decisions for similar meaning, which TypeSafe ranks above exact repeatability. [Home FAQ]
- **Version drift.** Aliases move when a release ships, "so its answers can change without any change to your code". TypeSafe advises pinning a versioned ID such as `jev-1.14.0` if you have tuned thresholds against it. [D-models]

## 3. Learning

- **No per-customer training.** "Jev is not fine-tuned or LoRA-adapted with customer data… the same weights serve every account." [D-models]
- **What is offered instead:** put reference material and examples in `state` ("context, examples, and other information"), write boundary cases into `criteria`, and break broad judgements into atomic questions combined in code. [D-models] [D-state]
- **Labelled data, used downstream.** The "Autoresearch feature discovery" cookbook trains a separate classifier (CatBoost) on Jev's answers to questions asked over labelled rows. The learning happens in the customer's own model, not in Jev. [D-llms index]
- **No feedback endpoint.** The 1.14 launch post mentions an **opt-in** that lets TypeSafe see your queries to find "jaggedness" ("We will still not train on your queries"). I found no API for sending feedback or corrections on a decision. [B-1.14]
- **Cost.** There is no training fee because there is no training. Examples placed in `state` are billed as input tokens at the normal rate.

## 4. Speed and price

| Item | Value | Source |
|---|---|---|
| Input price | **$0.042 / Mtok** ($42 / Btok), the same for `jev-1.14.0` and `jev-1.13.0`, and for long context **(vendor)** | [D-models] |
| Output price | **Free**: "currently free of charge" **(vendor)** | [D-api] |
| Latency | "Most calls complete in about 100 ms" **(vendor)**; "70ms–500ms" end to end **(vendor)**. The launch post says its published evals "are generally run from our laptops on the West Coast" | [D-system-one] [B-launch] |
| Workflow evals | Jev: 67.8% agreement, $0.0004 per case, 0.4 s per case. Claude Opus 5: 73.1%, $0.1761, 37.8 s. GPT-5.6 Sol: 74.1%, $0.0836, 23.3 s **(vendor)**. The "193.6× faster, 444.6× cheaper" headline comes from these, and TypeSafe itself says they are "on the higher end of real world gains" | [Evals] [B-launch] |
| Rate limits | Per organisation, in tokens/s and requests/s. **The actual numbers are shown only in the console**; I found no published defaults. Higher limits come on custom/enterprise plans, by request form | [D-models] |
| Free tier | **None.** "TypeSafe is not offering startup, research or trial credits at this time." (A "$5 free credit" claim appears only on aggregator blogs, low quality, and the help centre contradicts it.) | [H-trial] |
| Billing | Prepaid credits bought in the console (Admin only). They are **non-refundable**, including unused credit, and **expire 12 months after purchase** (or at the end of the term). Payment is in US dollars | [H-credits] [H-refund] [H-expire] [MCA §8] |
| Spend cap | **Auto-recharge is opt-in.** With it off, an empty balance means "requests return a 402 error until you add credits". I found no per-key or per-month spend limit; usage and spend can be viewed by user and by API key under Settings → Usage | [H-autorecharge] [H-usage] |
| Subsidy | "We can serve Jev profitably at our current prices." **(vendor)** The launch post says: "We can't prove it isn't subsidized." | [Home FAQ] [B-launch] |

## 5. Availability

- **Stage.** It launched 15 Sep 2026 "in early access", with developers brought "off the waitlist as quickly as we can". [B-launch] The homepage meta description still says "Try… Jev, in early access". [Home] The help centre's sign-up article (updated about 4 Nov 2026) says "you do not need waitlist approval". [H-signup] **I found no general availability announcement.** TechCrunch reports that at launch, demand meant the company "briefly lost the ability to serve API users" **(press)**.
- **SLA: none.** The MCA's only performance promise is that the Services "will perform materially as described in its Documentation". Beyond that they are "as is" and "as available", with no warranty of being "uninterrupted or error-free". Support is "commercially reasonable efforts" by email (`support@typesafe.ai`). Enterprise terms might differ; I found no published enterprise SLA. [MCA §3, §9]
- **Status page:** `status.typesafe.ai`, hosted on Better Stack. Shown on 2026-11-08: `api.typesafe.ai` uptime 99.942% over 30 days, 99.841% over 60 days and 99.882% over 90 days. Listed incidents include the API down 2 min (21 Sep), 12 min (23 Sep) and 11 min (28 Sep), elevated latency in us-east-1 for 45 min (14 Oct), and a "system overload" degrading the API for 1 h 15 min (30 Oct). [Status]
- **Regions.** "Requests sent to the TypeSafe API are processed in the United States. Regional endpoints aren't currently available." [H-region] The status page nonetheless lists `api.us.typesafe.ai` and us-east-1, us-east-2 and us-west-2 as monitored components. All of them are in the US.

## 6. Data

### What happens to inputs

- **No training on customer data.** MCA §4.1: TypeSafe "will not include Customer Data in a dataset used to train (i.e., to modify the model weights of) any artificial intelligence or machine learning models without Customer's prior consent". The Privacy Policy and help centre say the same, and the help centre adds: "There's nothing to opt out of." [MCA §4.1] [Privacy] [H-retained]
- **Licence to use Customer Data.** During the Term, TypeSafe may use Customer Data to provide the service and calculate fees. **"In perpetuity"**, it may use Customer Data "(i) to derive and generate Telemetry, (ii) to monitor for fraud and abuse… and (iii) as necessary to comply with applicable Laws". [MCA §4.1]
- **Telemetry** means "technical logs, hashes, summary statistics and classifications, metrics, and learnings related to Customer's use". TypeSafe "may Process Telemetry without restriction, including to improve the Services". The MCA §4.3 definition does not exclude content. The help centre says "Telemetry doesn't include the content of your inputs or outputs". [MCA §4.3] [H-retained]
- **Retention.** "We don't publish a fixed retention period for standard usage. Data is kept only as long as reasonably necessary." The DPA's Schedule I says the same ("as long as necessary taking into account the purpose"). **Individual requests cannot be deleted**: "We can't delete individual requests or data from specific dates." ZDR can instead be applied retroactively to the whole organisation. [H-retained] [H-delete] [DPA Sch. I §8]
- **Zero data retention.** "ZDR deletes request content upon output." **The sources disagree on who can have it.** The docs' Legal page and the Enterprise page say ZDR is for "enterprise customers". The help centre says it "is free for every organization" and "available by request" through a support form, and is confirmed by email and shown under Settings → Organization. [D-legal] [Enterprise] [H-baa] [H-zdr]
- **Where.** Processing is in the US only. The Privacy Policy notes that users outside the US are "transferring your personal data outside of those regions to the U.S.". [H-region] [Privacy]
- **Other terms that matter.** TypeSafe "may delete Customer Data at any time in its sole discretion". It may name the customer publicly unless asked in writing not to. Liability is capped at the greater of 12 months' fees or **$50**. The agreement is governed by California law, with JAMS arbitration in San Francisco. TypeSafe can update the MCA on 60 days' notice, and the API may change in ways that break a customer application, with "commercially reasonable efforts" to give notice. [MCA §2.5, §10.3, §12.2, §15, §16.2, §16.4, §16.7]

### DPA and sub-processors

- **DPA** (Data Processing Addendum, last updated 24 Apr 2026), incorporated into the MCA. Its terms: TypeSafe acts as processor and service provider, with CCPA "no sell/share" terms; EU SCCs (Module 2/3, Irish law) and the UK Addendum; security-incident notice "without undue delay and in any case within 72 hours"; one customer audit a year at the customer's cost; and 15 days to object to a new sub-processor. **Schedule I lists "Sensitive Data Transferred: N/A."** [DPA]
- **Sub-processors:** the DPA and help centre point to `trust.typesafe.ai/subprocessors`, a Vanta trust centre that renders only in a browser. **I could not read the list**: a plain fetch returns an empty shell, and the browser extension was not connected. [DPA §3.1] [H-dpa]
- **SOC 2 Type II:** "Yes", with access requested through the Trust Center. [Enterprise FAQ]

### Health data (the Pilot is a physio clinic)

- **HIPAA / BAA: no.** The Enterprise FAQ says "No. We don't currently support HIPAA compliance or sign business associate agreements (BAAs)". The help centre says "Not yet. We currently can't sign Business Associate Agreements (BAAs) and aren't HIPAA compliant", and adds that ZDR "isn't a substitute for a BAA". There is a BAA waitlist, and TypeSafe is "working toward" Bedrock, Azure and Vertex for "teams with BAA/HIPAA requirements", with no date. [Enterprise FAQ] [H-baa] [H-dpa-baa]
- **Acceptable Use Policy:** it does not forbid health data as input. It forbids phishing "to obtain… health information" and disclosing sensitive information without permission. The help centre asks teams making "decisions about people in regulated settings" to "contact us before you launch rather than after". [AUP §1.3, §1.7] [H-build]
- **Australian privacy law: nothing found.** None of TypeSafe's documents mentions Australia, the Privacy Act 1988 or the Australian Privacy Principles. The DPA covers the EU, UK, Switzerland and CCPA only. *(Context, not from TypeSafe: under the Privacy Act 1988, health information is "sensitive information", and APP 8 governs disclosure to overseas recipients. US-only processing would therefore be a cross-border disclosure.)*

## 7. Vendor risk

- **Company.** TypeSafe AI, Inc., San Francisco. It spent two years in stealth before launch. Founders are Diogo Almeida (CEO, ex-OpenAI, credited with co-inventing RLHF), Erik Gafni and Sasha Sheng. [B-launch] [D-primer] [press: TechCrunch]
- **Funding: two rounds, so the figures in the issue do not conflict.**
  1. **Seed: $40M, led by DCVC, announced with the launch on 15 Sep 2026 (press: The Register, VKTR).** TypeSafe's own launch post does not give the amount.
  2. **Series A: on 9 Oct 2026, TypeSafe's blog announced "a really big series A" led by Andreessen Horowitz, with Sequoia, DCVC and angels. Its footnote reads "$870 million at a $7.5B valuation, with Martin Casado joining the board."** Bloomberg reported the same figures on 9 Oct (seen only through secondary sites such as runtimewire.com, aggregator, low quality). [B-seriesA]
  - Other numbers found only on aggregators (low quality, unverified): a ~$200M valuation at launch "reported by Forbes" and a report that TypeSafe was "seeking $1B" (stockanalysis.com).
- **Traction claims (vendor):** "A third of the Fortune 500 are getting their Jev on"; "We've saved customers millions of dollars". [B-seriesA] Case studies named on the Enterprise page: Jack & Jill, MotherDuck and Sardine.
- **Model provenance.** Per TechCrunch, Almeida says Jev is trained only on synthetic data, and outside observers suspect it is built on an open-weight LLM. That is unconfirmed, and Almeida declined to discuss the architecture **(press)**.
- **Deprecation.** **There is no formal policy yet.** The 1.14 post says: "We intend to give 60 days warning before jev-1.13.0 is formally deprecated, and 30 days for jev-1.14.0. We'll release a deprecation policy prior to this." `jev-1.13.0` "will be available for a while". [B-1.14]
- **Lock-in surface.** The SDKs accept any base URL that implements the TypeSafe OpenAPI spec. TypeSafe also publishes a Python "System One LLM wrapper" (`github.com/typesafe-ai/system-one-adapter-python`) that constrains LLMs to answer in the same structured form. It uses that wrapper to compare LLMs in its own evals. [D-llms-full] [B-launch]
- **Licence restriction:** the MCA §2.3(b) forbids using Output "to perform model distillation, train a model to imitate the output of the Services, or develop… a similar or competing product". [MCA §2.3]

## Not found

- The **sub-processor list** (in a JS-only Vanta page I could not render; see §6).
- **Default rate-limit numbers.** They are shown in the console only.
- **Any calibration measurement**: no reliability diagram, ECE, Brier score or per-task accuracy against ground truth.
- **An SLA**, an uptime commitment, or service credits, including for enterprise.
- **A general availability announcement**, or any statement that early access has ended. The only sign is that the help centre no longer requires waitlist approval.
- **Per-key or monthly spend limits.** Only the prepaid balance with auto-recharge off acts as a cap.
- **A formal deprecation policy.** Only the stated intent above exists.
- **Any mention of Australia** or the Privacy Act 1988 / APPs, and any data residency outside the US.
- **An API for feedback or corrections** on decisions.
- **Documented latency percentiles** (p50/p95/p99). Only the vendor ranges above exist.
- **Which side is right about ZDR**: enterprise-only (docs, Enterprise page) or free for every organisation (help centre).
- TypeSafe's **own statement of the $40M seed**. The figure appears in press only.

## Sources

TypeSafe docs (`docs.typesafe.ai`, raw Markdown via the `.md` URLs listed in `/llms.txt`):

- [D-intro] [Introduction](https://docs.typesafe.ai/introduction)
- [D-quickstart] [Quick start](https://docs.typesafe.ai/introduction/quickstart)
- [D-coding-agents] [Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents)
- [D-system-one] [System One](https://docs.typesafe.ai/concepts/system-one)
- [D-state] [State](https://docs.typesafe.ai/concepts/state)
- [D-advanced] [Advanced: structure](https://docs.typesafe.ai/primitives/advanced)
- [D-confidence] [Confidence](https://docs.typesafe.ai/confidence)
- [D-primer] [AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer)
- [D-models] [Models](https://docs.typesafe.ai/models) (`typesafe.ai/pricing` serves this same page)
- [D-jaggedness] [Model jaggedness](https://docs.typesafe.ai/model-jaggedness)
- [D-legal] [Legal](https://docs.typesafe.ai/legal)
- [D-api] [System One API reference](https://docs.typesafe.ai/api/system-one) (embeds `https://api.typesafe.ai/openapi.json`)
- [D-errors] [Request rules and errors](https://docs.typesafe.ai/api/errors)
- [D-sdk-python] [Python SDK](https://docs.typesafe.ai/sdk/python)
- [D-sdk-constants] [Python SDK constants](https://docs.typesafe.ai/sdk/python/api/constants)
- [D-sdk-js] [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [D-llms index] [llms.txt](https://docs.typesafe.ai/llms.txt)
- [D-llms-full] [llms-full.txt](https://docs.typesafe.ai/llms-full.txt)

TypeSafe legal pages (`typesafe.ai/legal`):

- [MCA] [Master Customer Agreement](https://typesafe.ai/legal/mca) (last updated 23 Sep 2026)
- [DPA] [Data Processing Addendum](https://typesafe.ai/legal/data-processing) (last updated 24 Apr 2026)
- [Privacy] [Privacy Policy](https://typesafe.ai/legal/privacy-policy) (last updated 19 Nov 2025)
- [AUP] [Acceptable Use Policy](https://typesafe.ai/legal/acceptable-use-policy) (last updated 23 Sep 2026)
- [Terms of Use](https://typesafe.ai/legal/terms) (19 Sep 2026; covers the website only)

TypeSafe site and blog:

- [Home] [typesafe.ai](https://typesafe.ai)
- [Home FAQ] the homepage FAQ, whose answers load from the page's Framer script
- [Enterprise] [Enterprise](https://typesafe.ai/enterprise)
- [Enterprise FAQ] the Enterprise page FAQ, whose answers load from the page's Framer script
- [B-launch] [Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) (15 Sep 2026)
- [B-1.14] [Jev: For the builders AND dreamers](https://typesafe.ai/blog/jev-1-14) (14 Oct 2026)
- [B-seriesA] [TypeSafe A raises Series AI](https://typesafe.ai/blog/series-ai) (9 Oct 2026)
- [Evals] [Workflow evals](https://evals.typesafe.ai/)
- [Status] [status.typesafe.ai](https://status.typesafe.ai)

TypeSafe help centre (`help.typesafe.ai`):

- [H-signup] [How do I create or activate my account after an invitation or waitlist approval?](https://help.typesafe.ai/articles/4519713419-how-do-i-create-or-activate-my-account-after-an-invitation-or-waitlist-approval)
- [H-credits] [How do I add credits?](https://help.typesafe.ai/articles/7771619341-how-do-i-add-credits)
- [H-refund] [What is TypeSafe's refund policy?](https://help.typesafe.ai/articles/5054262299-what-is-typesafe-s-refund-policy)
- [H-402] [What's a 402 error?](https://help.typesafe.ai/articles/5505198974-what-s-a-402-error-and-how-can-i-add-more-credits)
- [H-expire] [Do credits expire?](https://help.typesafe.ai/articles/8157705264-do-credits-expire)
- [H-autorecharge] [How do I turn off automatic top-ups?](https://help.typesafe.ai/articles/6963467072-how-do-i-turn-off-automatic-top-ups-auto-recharge)
- [H-usage] [Where can I see my usage and spend?](https://help.typesafe.ai/articles/9325343771-where-can-i-see-my-usage-and-spend)
- [H-trial] [Do you offer startup, research or trial credits?](https://help.typesafe.ai/articles/1592415054-do-you-offer-startup-research-or-trial-credits-or-redeem-codes)
- [H-retained] [How is submitted data used or retained?](https://help.typesafe.ai/articles/5974925716-how-is-submitted-data-used-or-retained)
- [H-zdr] [Do you offer ZDR?](https://help.typesafe.ai/articles/9520184411-do-you-offer-zdr)
- [H-delete] [How do I delete my data?](https://help.typesafe.ai/articles/7169691662-how-do-i-delete-my-data)
- [H-baa] [Do you sign BAAs or support HIPAA?](https://help.typesafe.ai/articles/5089157237-do-you-sign-baas-or-support-hipaa)
- [H-dpa-baa] [Do you offer a DPA/BAA/SCC and specific data-residency options?](https://help.typesafe.ai/articles/9159694888-do-you-offer-a-dpa-baa-scc-and-specific-data-residency-options)
- [H-dpa] [Where can I find your DPA and subprocessor list?](https://help.typesafe.ai/articles/3647873012-where-can-i-find-your-dpa-and-subprocessor-list)
- [H-region] [Where is my data processed?](https://help.typesafe.ai/articles/6650083203-where-is-my-data-processed)
- [H-bedrock] [Is Jev available on Amazon Bedrock, Google Vertex AI, or Azure Foundry?](https://help.typesafe.ai/articles/2088283656-is-jev-available-on-amazon-bedrock-google-vertex-ai-or-azure-foundry)
- [H-build] [What can and can't I build with Jev?](https://help.typesafe.ai/articles/4186051058-what-can-and-cant-i-build-with-jev)

Press (used only where TypeSafe's own pages are silent):

- [The Register, 16 Sep 2026](https://www.theregister.com/a/5296711): the $40M figure, and the observation that calibration comes with no metrics
- [TechCrunch, 18 Sep 2026](https://techcrunch.com/?p=3165837): the founders, the launch-day capacity loss, the synthetic training data, the open-weight suspicion, and user quotes
- [VKTR](https://www.vktr.com/ai-platforms/chatgpt-cocreator-launches-typesafe-ai-with-jev/): the $40M seed led by DCVC, and the rolling waitlist

Aggregators (low quality, used only to show where a claim comes from):

- runtimewire.com (relaying Bloomberg's $870M report)
- stockanalysis.com (the Forbes and Telegraph valuation mentions)
- several "Jev waitlist / free credit" SEO blogs (the $5 credit claim, which the help centre contradicts)
