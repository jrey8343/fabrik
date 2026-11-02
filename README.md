# Fabrik

A software factory: an agent-driven engineering loop that takes work from idea → spec → tickets → shipped code.

Status: building v1. See the Spec in GitHub Issues (#28).

## Layout

- `src/loop/` holds the **Loop rules core**: a pure function, `planFor(event, snapshot, config)`, that returns a plan. It does no I/O, and its tests (`*.test.ts`, next to the code) are the Loop's behaviour, one sentence each.
- `src/__fixtures__/` holds the snapshot builders the core's tests use.
- `src/github/` holds the thin **GitHub adapter**: it maps an Actions event to a Loop event, gathers the snapshot and applies the plan.
- `src/main.ts` is what a push job runs (`node src/main.ts`, Node 24, no build step and no runtime dependencies).
- `.github/workflows/loop.yml` is the reusable workflow a Product repo calls. It holds wiring only.
- `templates/fabrik.yml` is the caller workflow a Product repo installs as `.github/workflows/fabrik.yml`.

## Developing

```sh
npm install
npm run typecheck
npm test
```

## What a Product repo needs today

- The Fabrik GitHub App installed (Issues, Pull requests and Contents; no `workflows`).
- A 1Password item `Fabrik App` in the `Fabrik App` vault, with fields `client-id` and `private-key`.
- The repo's read-only push service account (reads the `Fabrik App` vault) stored as the Actions secret `FABRIK_OP_PUSH_TOKEN`.
- `templates/fabrik.yml` installed as `.github/workflows/fabrik.yml`, pinned to a Fabrik tag.
