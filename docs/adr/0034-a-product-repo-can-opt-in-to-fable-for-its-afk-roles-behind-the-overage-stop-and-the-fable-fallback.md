# A Product repo can opt in to Fable for its AFK roles, behind the overage stop and the Fable fallback

The Kit refused Fable in every AFK role, because past Fable's included share a `-p` run bills usage credits without asking. A Product repo can now opt in with `allow_fable`. Three guards make that safe. The Operator keeps usage credits off on every listed Subscription, so a run at the cap is refused and never billed. Every Fable run stops on its first overage message, rotation or not, so credits left on by mistake spend nothing. A run refused on a Fable cap falls back to Opus 5.5 at the same effort, on that run only, until the cap resets, so a Fable cap never holds a run. We chose this because the Operator's two Subscriptions carry a Fable allowance a weekly loop otherwise leaves unused, and because Design, Review and the Step-up are where a stronger model pays for itself.

## Considered options

- **Keep the refusal.** It leaves the Fable allowance unused, with nothing to show the risk is still there once the guards exist.
- **Lift the refusal for every repo.** A copied config would turn Fable on silently, in a repo whose Operator never checked their credits.
- **Hold the Fable roles at a Fable cap,** and let Opus runs carry on. Design, Review and the Step-up would stall for up to a week.
- **A Kit-owned issue for each Fable cap.** It asks nothing of the Operator, so by the Kit's push rules it mustn't push.
- **Accept `best` or the bare `fable` alias.** Either can resolve to another model on a CLI upgrade or an environment variable, unseen.

## Consequences

- Usage credits off on every listed Subscription is now a precondition of the opt-in. The Kit can't read that setting, so the overage stop is the backstop.
- A Fable cap is told apart from the weekly limit by its `rateLimitType`, which isn't documented. Until a real one confirms it, a Fable cap that reads as plain `seven_day` holds its Subscription as the weekly limit does.
- A role that names Fable can run on Opus for part of a week, and its Run records and the Weekly summary say so.
- A Replay arm never falls back, so a Fable cap can end a Replay early.
- A repo that doesn't opt in behaves exactly as before.
