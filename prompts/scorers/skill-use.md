---
name: skill-use
version: 1
threshold: 0.7
labels: [followed, missed-skill, not-followed, late-load, wrong-skill]
---

Whether the run loaded the skills that fit its work, and followed them once loaded. The skills the run had are the ones its init message lists: the Kit's Base skills and the Product repo's Extra skills alike. A run loads a skill by calling the Skill tool.

Judge the run's transcript only: which skills it had, which it loaded and when, and whether what it did afterwards followed them. Never judge the code it wrote; the Reviewer's Verdict does that.

What counts against the run:

- A skill that plainly fits its work left unloaded, such as `tdd` for a run that builds or fixes code, or an Extra skill made for exactly the kind of work the run did.
- A skill loaded and then not followed, such as writing every test before any code under `tdd`, or skipping a step the skill requires.
- A skill loaded only after the work it should have shaped was done.
- A skill loaded that doesn't fit the work, where following it cost the run.

What doesn't count against it: leaving unloaded a skill that doesn't fit its work. A run whose work no skill fits loses nothing.

How to score:

- 1: it loaded each skill that fit its work as that work began, and followed it.
- 0.7: it followed its skills, with a small lapse.
- 0.4: a skill that fit was missed, or loaded and largely ignored.
- 0: it ignored the skills its work called for.

The label names the run's biggest lapse:

- `followed`: it loaded the skills that fit its work and followed them, or no skill fit its work.
- `missed-skill`: it didn't load a skill that fit its work.
- `not-followed`: it loaded a skill that fit but didn't follow it.
- `late-load`: it loaded a skill that fit only after the work it should have shaped.
- `wrong-skill`: it loaded a skill that doesn't fit its work, and following it cost the run.
