#!/usr/bin/env python3
"""Fabrik's per-role baseline, as raw counts (Decision #346).

    python3 -I baseline.py STORE GH ARTIFACTS

STORE is a clone of jrey8343/fabrik-runs. GH and ARTIFACTS are the
directories fetch.sh fills from the Pilot (timelines, PR reviews, Actions jobs,
and the Actions artifacts holding each agent run's transcript and result).
It prints counts, durations, costs and issue numbers only: never issue text,
comment bodies or transcript content.
"""
import collections
import glob
import gzip
import json
import os
import re
import statistics
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

STORE, GH, ART = sys.argv[1:4]
SYDNEY = ZoneInfo("Australia/Sydney")
BOT = "fabrik-factory[bot]"
OPERATOR = "jrey8343"
STATES = ("needs-triage", "needs-info", "needs-design", "ready-for-agent", "ready-for-human", "wontfix")
CATEGORIES = ("bug", "enhancement")


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def week(s):
    """The Monday a week began on in the Operator's time zone, as the Weekly summary counts weeks."""
    d = ts(s).astimezone(SYDNEY).date()
    return (d - timedelta(days=d.weekday())).isoformat()


def pct(xs, p):
    """Nearest-rank percentile; None for an empty list."""
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    k = max(1, -(-len(xs) * p // 100))
    return xs[int(k) - 1]


def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def fmt(x, unit=""):
    if x is None:
        return "n/a"
    if unit == "min":
        return f"{x / 60000:.1f}"
    if unit == "$":
        return f"{x:.2f}"
    if unit == "k":
        return f"{x / 1000:.0f}k"
    return str(x)


def section(title):
    print(f"\n## {title}\n")


# ---------------------------------------------------------------- runs

def tokens(usage):
    t = collections.Counter()
    for m in (usage or {}).values():
        for k in ("inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"):
            t[k] += m.get(k) or 0
        # A transcript's modelUsage spells cache tokens the SDK's way.
        t["cacheWriteTokens"] += m.get("cacheCreationInputTokens") or 0
        t["cacheReadTokens"] += m.get("cacheReadInputTokens") or 0
    return t


def from_transcript(path):
    """The fields a Run record takes from a stream-json transcript."""
    out = {"result": None, "rate": None, "model": None}
    with gzip.open(path, "rt", errors="replace") as fh:
        for line in fh:
            try:
                m = json.loads(line)
            except ValueError:
                continue
            kind = m.get("type")
            if kind == "result":
                out["result"] = m
            elif kind == "rate_limit_event":
                out["rate"] = m.get("rate_limit_info", m)
            elif kind == "system" and m.get("subtype") == "init":
                out["model"] = m.get("model")
    return out


runs = {}  # (actions run id, role) -> run
for f in glob.glob(os.path.join(STORE, "runs", "*", "*", "*", "*.json")):
    r = json.load(open(f))
    role = "design-prototype" if r.get("prototype") else r["role"]
    runs[(r["runId"], role)] = {
        "source": "store", "role": role, "issue": r["issue"], "pr": r["pullRequest"], "ended": r["endedAt"],
        "model": r["model"], "retry": r["retry"], "stepUp": r["stepUp"], "requestChanges": r["requestChanges"],
        "ok": r["jobResult"] == "success", "verdict": r["verdict"], "dur": r["durationMs"], "api": r["apiDurationMs"],
        "turns": r["turns"], "cost": r["totalCostUsd"], "tok": tokens(r["modelUsage"]),
        "util": (r["rateLimit"] or {}).get("utilization"), "rlType": (r["rateLimit"] or {}).get("rateLimitType"),
    }

actions = {}
for line in open(os.path.join(GH, "actions_runs.jsonl")):
    a = json.loads(line)
    actions[a["id"]] = a

AGENT_JOB = re.compile(r"^loop / (Triage|Design-session turn|Prototype turn|Implement|Review|Retro|Audit|Research|Score)( #\d+)?$")
JOB_ROLE = {"Triage": "triage", "Design-session turn": "design", "Prototype turn": "design-prototype", "Implement": "implement",
            "Review": "review", "Retro": "retro", "Audit": "audit", "Research": "research", "Score": "score"}
agent_jobs = []  # every agent job attempt in the Actions history
job_end = {}  # (actions run id, role) -> when its agent job completed
for line in open(os.path.join(GH, "jobs.jsonl")):
    j = json.loads(line)
    m = AGENT_JOB.match(j["name"])
    if m and j["started_at"] and j["completed_at"]:
        j["role"] = JOB_ROLE[m.group(1)]
        agent_jobs.append(j)
        job_end[(j["run_id"], j["role"])] = max(job_end.get((j["run_id"], j["role"]), ""), j["completed_at"])

mismatch = 0
for d in glob.glob(os.path.join(ART, "*", "fabrik-transcript-*")):
    run_id = int(os.path.basename(os.path.dirname(d)))
    role = re.match(r"fabrik-transcript-([a-z]+)-\d+$", os.path.basename(d)).group(1)
    paths = glob.glob(os.path.join(d, "*.jsonl.gz"))
    if not paths:
        continue
    t = from_transcript(paths[0])
    res = t["result"] or {}
    result_path = glob.glob(os.path.join(ART, str(run_id), "fabrik-agent-result-*", "agent-result.json"))
    issue = json.load(open(result_path[0])).get("issue") if result_path else None
    key = (run_id, role)
    if (run_id, "design-prototype") in runs and role == "design":
        continue  # the store's one prototype turn; the Actions jobs show no other
    if key in runs:
        if runs[key]["cost"] is not None and abs((res.get("total_cost_usd") or 0) - runs[key]["cost"]) > 1e-6:
            mismatch += 1
        continue
    ended = job_end.get(key) or actions.get(run_id, {}).get("updated_at")
    runs[key] = {
        "source": "actions", "role": role, "issue": issue, "pr": None, "ended": ended, "model": t["model"],
        "retry": None, "stepUp": None, "requestChanges": None, "ok": res.get("subtype") == "success" and not res.get("is_error"),
        "verdict": None, "dur": res.get("duration_ms"), "api": res.get("duration_api_ms"), "turns": res.get("num_turns"),
        "cost": res.get("total_cost_usd"), "tok": tokens(res.get("modelUsage")),
        "util": (t["rate"] or {}).get("utilization"), "rlType": (t["rate"] or {}).get("rateLimitType"),
    }

section("Runs per role and week (store records, plus Actions transcripts for runs before the store)")
by = collections.defaultdict(list)
for r in runs.values():
    by[(r["role"], week(r["ended"]))].append(r)
print("| role | week | runs | store | pre-store | with result | median min | p90 min | median API min | p90 API min "
      "| median turns | API-eq $ total | median $ | p90 $ | input | output | cache write | cache read |")
print("|" + "---|" * 18)
week_total = collections.Counter()
for (role, wk), rs in sorted(by.items()):
    withres = [r for r in rs if r["cost"] is not None]
    tok = sum((r["tok"] for r in rs), collections.Counter())
    cost = sum(r["cost"] or 0 for r in rs)
    week_total[wk] += cost
    print(f"| {role} | {wk} | {len(rs)} | {sum(r['source'] == 'store' for r in rs)} | {sum(r['source'] == 'actions' for r in rs)} "
          f"| {len(withres)} | {fmt(med([r['dur'] for r in rs]), 'min')} | {fmt(pct([r['dur'] for r in rs], 90), 'min')} "
          f"| {fmt(med([r['api'] for r in rs]), 'min')} | {fmt(pct([r['api'] for r in rs], 90), 'min')} "
          f"| {fmt(med([r['turns'] for r in rs]))} | {cost:.2f} | {fmt(med([r['cost'] for r in rs]), '$')} "
          f"| {fmt(pct([r['cost'] for r in rs], 90), '$')} | {fmt(tok['inputTokens'], 'k')} | {fmt(tok['outputTokens'], 'k')} "
          f"| {fmt(tok['cacheWriteTokens'], 'k')} | {fmt(tok['cacheReadTokens'], 'k')} |")
print()
for wk, c in sorted(week_total.items()):
    print(f"- {wk}: API-equivalent total ${c:.2f}")
per_day = collections.defaultdict(lambda: [0, 0.0])
for r in runs.values():
    d = ts(r["ended"]).astimezone(SYDNEY).date().isoformat()
    per_day[d][0] += 1
    per_day[d][1] += r["cost"] or 0
print("Per day (Sydney):", {d: f"{n} runs, ${c:.2f}" for d, (n, c) in sorted(per_day.items())})
print("\nShare of the week's API-equivalent dollars, per role:")
for (role, wk), rs in sorted(by.items()):
    print(f"- {role} {wk}: {100 * sum(r['cost'] or 0 for r in rs) / week_total[wk]:.1f}%")
print(f"\nStore records whose cost disagrees with their Actions transcript: {mismatch}")
print("Runs whose durationMs is below their apiDurationMs:",
      sorted((k[0], k[1]) for k, r in runs.items() if r["dur"] is not None and r["api"] is not None and r["dur"] < r["api"]))
print("Weekly-limit readings (rateLimitType, utilization) over all runs:",
      dict(collections.Counter((r["rlType"], r["util"]) for r in runs.values())))
print("Model per role:", dict(collections.Counter((r["role"], r["model"]) for r in runs.values())))

# ---------------------------------------------------------------- Actions jobs

section("Agent jobs in the Pilot's Actions history (wall clock, every attempt)")
jobs = collections.defaultdict(list)
for j in agent_jobs:
    jobs[(j["role"], week(j["started_at"]))].append(j)
print("| role | week | jobs | success | failure | cancelled | median wall min | p90 wall min |")
print("|---|---|---|---|---|---|---|---|")
for (name, wk), js in sorted(jobs.items()):
    c = collections.Counter(j["conclusion"] for j in js)
    wall = [(ts(j["completed_at"]) - ts(j["started_at"])).total_seconds() * 1000 for j in js]
    print(f"| {name} | {wk} | {len(js)} | {c['success']} | {c['failure']} | {c['cancelled']} "
          f"| {fmt(med(wall), 'min')} | {fmt(pct(wall, 90), 'min')} |")
missing = collections.defaultdict(list)
for j in agent_jobs:
    if (j["run_id"], j["role"]) not in runs:
        missing[j["role"]].append(f"{j['started_at'][5:16]}:{j['conclusion']}")
print("\nAgent jobs with neither a Run record nor a transcript (role: start:conclusion):")
for role, xs in sorted(missing.items()):
    print(f"- {role} ({len(xs)}): {', '.join(sorted(xs))}")
print("First run with a cost figure, per role:",
      {role: min(r["ended"] for r in runs.values() if r["role"] == role)[:16] for role in sorted({r["role"] for r in runs.values()})})

# ---------------------------------------------------------------- GitHub timelines

timeline = {}
for f in glob.glob(os.path.join(GH, "tl", "*.json")):
    timeline[int(os.path.basename(f)[:-5])] = sorted(json.load(open(f)), key=lambda e: e.get("created_at") or e.get("submitted_at") or (e.get("author") or {}).get("date") or "")
prs = {p["number"]: p for p in json.load(open(os.path.join(GH, "prs.json")))}
issues = {i["number"]: i for i in json.load(open(os.path.join(GH, "issues.json")))}


def actor(e):
    return (e.get("actor") or e.get("user") or {}).get("login")


def when(e):
    return e.get("created_at") or e.get("submitted_at") or (e.get("author") or {}).get("date")


def marker(e):
    if e.get("event") != "commented" or actor(e) != BOT:
        return None, None
    m = re.match(r"<!-- (fabrik:[a-z-]+)\s*(\{.*?\})?", e["body"])
    if not m:
        f = re.match(r"@\S+ The (\w+(?: \w+)?) run on #\d+ failed: ([^.]*)", e["body"])
        return ("failure", {"role": f.group(1), "why": re.sub(r"\d+", "N", f.group(2))}) if f else (None, None)
    return m.group(1), (json.loads(m.group(2)) if m.group(2) else {})


section("Triage outcomes (Pilot issues)")
triaged = []  # (issue, state, category, time)
failed_triage = []
for n, evs in sorted(timeline.items()):
    if n in prs:
        continue
    for i, e in enumerate(evs):
        if e.get("event") == "unlabeled" and e["label"]["name"] == "needs-triage" and actor(e) == BOT:
            t0 = ts(when(e))
            added = [x["label"]["name"] for x in evs[i + 1:] if x.get("event") == "labeled" and actor(x) == BOT
                     and 0 <= (ts(when(x)) - t0).total_seconds() <= 90]
            state = next((s for s in added if s in STATES), None)
            cat = next((c for c in added if c in CATEGORIES), None)
            (triaged if state else failed_triage).append((n, state, cat, when(e)))
print("Triage runs that set a state:", len(triaged), " that set none (failed):", [x[0] for x in failed_triage])
print("States:", dict(collections.Counter(x[1] for x in triaged)))
print("Categories:", dict(collections.Counter(x[2] for x in triaged)))
print("State x category:", dict(collections.Counter((x[1], x[2]) for x in triaged)))
print("Per issue:", [(x[0], x[1], x[2], x[3][:10]) for x in triaged])
skill_made = [n for n, i in issues.items() if i["author"]["login"] == "app/fabrik-factory"]
print("Issues the Loop's own skills made (never triaged):", len(skill_made))
print("Issues created by the Operator:", sum(1 for i in issues.values() if i["author"]["login"] == OPERATOR))

print("\nWhat the Operator did after each successful Triage (label changes, re-triage, close):")
for n, state, cat, t in triaged:
    later = [e for e in timeline[n] if when(e) and when(e) > t and actor(e) == OPERATOR
             and (e.get("event") in ("labeled", "unlabeled") and e["label"]["name"] in STATES + CATEGORIES
                  or e.get("event") in ("closed", "reopened"))]
    bot_sessions = [marker(e)[0] for e in timeline[n] if when(e) and when(e) > t and marker(e)[0] == "fabrik:design-round"]
    print(f"- #{n} {state}/{cat}: operator={[(e['event'], (e.get('label') or {}).get('name') or e.get('state_reason')) for e in later]} "
          f"design_rounds_after={len(bot_sessions)} final={issues[n]['state']}/{issues[n]['stateReason']}")

section("needs-info")
for n, evs in sorted(timeline.items()):
    on = [e for e in evs if e.get("event") == "labeled" and e["label"]["name"] == "needs-info"]
    for e in on:
        t0 = when(e)
        reply = next((x for x in evs if x.get("event") == "commented" and when(x) > t0 and actor(x) != BOT), None)
        swap = next((x for x in evs if x.get("event") == "unlabeled" and x["label"]["name"] == "needs-info" and when(x) > t0), None)
        done = next((x for x in triaged if x[0] == n and x[3] > t0), None)
        print(f"- #{n}: labelled {t0}; author reply {when(reply) if reply else None}; swap {when(swap) if swap else None}; "
              f"re-triage done {done[3] if done else None}; reply to re-triage "
              f"{(ts(done[3]) - ts(when(reply))).total_seconds() / 60 if done and reply else None:.1f} min; re-triage state {done[1] if done else None}")

section("Intake: duplicates")
dups = [n for n, evs in timeline.items() if any(e.get("event") == "marked_as_duplicate" or e.get("state_reason") == "duplicate"
                                                or (e.get("label") or {}).get("name") == "duplicate" for e in evs)]
print("Issues closed or marked as duplicates:", dups)
print("Close reasons:", dict(collections.Counter((i["state"], i["stateReason"]) for i in issues.values())))

section("Verdicts and retries on agent PRs (from the Kit's comment markers)")
agent_prs = sorted(n for n, p in prs.items() if p["headRefName"].startswith("fabrik/ticket-"))
verdicts = []
for n in agent_prs:
    seq = []
    for e in timeline[n]:
        k, j = marker(e)
        if k == "fabrik:verdict":
            seq.append(("V:" + j["verdict"] + ("/ci" if j["source"] == "ci" else "") + ("/rc" if j.get("requestChanges") else ""), when(e)))
            verdicts.append((n, j["verdict"], j["source"], j.get("requestChanges"), when(e)))
        elif k in ("fabrik:retry-push", "fabrik:request-changes-run", "fabrik:empty-diff", "fabrik:back-to-design"):
            seq.append((k[7:], when(e)))
        elif k == "failure":
            seq.append(("failed:" + j["role"], when(e)))
        elif e.get("event") == "reviewed" and actor(e) == OPERATOR:
            seq.append(("op-review:" + e["state"], when(e)))
        elif e.get("event") == "committed" and (e.get("author") or {}).get("name") != "Fabrik Implementer":
            seq.append(("op-push", when(e)))
        elif e.get("event") in ("labeled", "unlabeled") and actor(e) == OPERATOR:
            seq.append((f"op-{e['event']}:{e['label']['name']}", when(e)))
        elif e.get("event") == "commented" and actor(e) == OPERATOR:
            seq.append(("op-comment", when(e)))
        elif e.get("event") in ("merged", "closed"):
            seq.append((f"{e['event']}:{actor(e)}", when(e)))
    ticket = int(prs[n]["headRefName"].split("-")[-1])
    print(f"- PR #{n} (Ticket #{ticket}, {prs[n]['state']}): " + ", ".join(f"{k}@{t[5:16]}" for k, t in seq))
print("\nVerdict spread (verdict, source, requestChanges):", dict(collections.Counter((v[1], v[2], v[3]) for v in verdicts)))
print("Verdict spread by week:", dict(collections.Counter((week(v[4]), v[1]) for v in verdicts)))
print("Failure notices by role and reason:", dict(collections.Counter(
    (marker(e)[1]["role"], marker(e)[1]["why"]) for evs in timeline.values() for e in evs if marker(e)[0] == "failure")))

section("Store records of Implement and Review runs, with their retry, Step-up and Verdict")
for k, r in sorted(runs.items(), key=lambda kv: kv[1]["ended"]):
    if r["role"] in ("implement", "review") and r["source"] == "store":
        print(f"- {r['ended'][:16]} {r['role']} issue #{r['issue']} pr {r['pr']} src={r['source']} model={r['model']} "
              f"retry={r['retry']} stepUp={r['stepUp']} rc={r['requestChanges']} verdict={r['verdict']} ${fmt(r['cost'], '$')}")

section("Implement and Review runs per Ticket, in order (store and Actions transcripts)")
ticket_of_pr = {n: int(p["headRefName"].split("-")[-1]) for n, p in prs.items() if p["headRefName"].startswith("fabrik/ticket-")}
chains = collections.defaultdict(list)
for r in runs.values():
    if r["role"] not in ("implement", "review") or r["issue"] is None:
        continue
    ticket = r["issue"]
    if r["source"] == "actions" and r["role"] == "review":
        ticket = ticket_of_pr.get(r["issue"], r["issue"])
    chains[ticket].append(r)
for ticket, rs in sorted(chains.items()):
    rs.sort(key=lambda r: r["ended"])
    steps = ", ".join(f"{r['ended'][5:16]} {r['role'][:4]}:{'opus' if 'opus' in (r['model'] or '') else 'sonnet'}:${fmt(r['cost'], '$')}"
                      + ("" if r["ok"] else ":fail") for r in rs)
    print(f"- Ticket #{ticket}: {steps}")
unmapped = [k for k, r in runs.items() if r["role"] in ("implement", "review") and r["issue"] is None]
print("Implement/Review transcripts with no agent result to map them to a Ticket:", unmapped)

section("Design sessions (from the Kit's round markers)")
for n, evs in sorted(timeline.items()):
    rounds = [e for e in evs if marker(e)[0] == "fabrik:design-round"]
    if not rounds:
        continue
    replies = [e for e in evs if e.get("event") == "commented" and actor(e) == OPERATOR and when(e) > when(rounds[0])]
    proto = sum(1 for e in evs if marker(e)[0] == "fabrik:prototype-request")
    failed = sum(1 for e in evs if marker(e)[0] == "fabrik:design-turn-failed")
    end = [e["label"]["name"] for e in evs if e.get("event") == "labeled" and actor(e) == BOT and when(e) > when(rounds[0])
           and e["label"]["name"] in ("ready-for-agent", "ready-for-human", "wontfix")]
    print(f"- #{n}: rounds={len(rounds)} operator replies={len(replies)} prototype requests={proto} failed turns={failed} "
          f"ended={end[-1] if end else (issues.get(n) or {}).get('stateReason') or 'open'}")

section("Scorers (score files in the store)")
for f in sorted(glob.glob(os.path.join(STORE, "scores", "*", "*", "*", "*.json"))):
    s = json.load(open(f))
    print(f"- Ticket #{s['issue']} PR {s['pullRequest']}: " + ", ".join(
        f"{e['scorer']}={e['score']}{'' if e['pass'] else ' FAIL'} ({e['label']})" for e in s["entries"]))
