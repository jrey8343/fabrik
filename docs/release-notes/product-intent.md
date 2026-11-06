# Release notes: Product intent

The notes for the minor release that ships Product intent and consequence ([#157](https://github.com/jrey8343/fabrik/issues/157)). Paste them into the release's notes file (see [releasing.md](../releasing.md)), with its version and pins.

## What changed

- A Product repo may keep two optional files that hold its Product intent, both free prose with no schema: `docs/product/vision.md`, the **Vision**, and `docs/product/roadmap.md`, the **Roadmap**. A commented example of each, for a made-up product, is in [`docs/examples/`](../examples/). Setup never installs them.
- Both are Trust-root files. The push job refuses an agent branch that changes anything under `docs/product/` at the repo root, renames into or out of it included, and names the path. A `docs/product/` folder nested elsewhere stays ordinary. Triage's test 5, Design's list of what an Implementer can't change, and the Implementer's "What you must not change" all name it.
- Triage has a sixth Fast-path test, "It changes no product intent". A change to who the product serves or what it promises them, a one-way door (a public name, a URL, a data shape, pricing, anything an End user is told), or something the Vision says the product deliberately doesn't do goes to `needs-design`, never down the Fast path. Size alone never fails it.
- Triage never closes an issue as `wontfix` on product grounds. An issue that conflicts with the Vision goes to `needs-design` with the conflicting line quoted. An idea it would otherwise set aside for being on no Roadmap list goes there too, saying so. The Roadmap gates nothing.
- A Design session, async or live with `/fabrik-live-design`, reads the Vision and Roadmap. An issue that touches Product intent opens with a product-intent block: who the change serves, why, how its success is measured, and what it deliberately leaves out, with recommendations drawn from the Vision. A Ticket sent back to design, and internal or technical work, skip it. Priority is asked only when an issue conflicts with Now.
- Every Spec opens with a **Product intent** section above its technical sections, and every agent brief opens with a "Who and why" line. When a session decides something the Vision doesn't yet say, its outcome carries an "Update `vision.md`" Operator step with the exact lines. No agent ever edits the Vision or the Roadmap.
- No shim changes, no Kit config fields and no setup step. Without the two files, Triage and Design work as before, except that Design asks the intent questions directly.

## No step to take

A Product repo only merges the bump PR. Writing a Vision and Roadmap is optional and can come later. As for every release, merge it in the Pilot first ([Validating on the Pilot](../releasing.md#validating-on-the-pilot)), and check there:

- an issue that changes something End users are told, such as a price or a public name, goes to `needs-design` rather than the Fast path, and a small bug fix still takes the Fast path,
- a Design session on such an issue opens with the product-intent block, and the Spec or brief it writes carries the Product intent section or the "Who and why" line.
