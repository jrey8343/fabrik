# Prototype: the Console's Home screen

Throwaway. This branch is never merged.

Three structurally different variants of Home, for the Decision
[Prototype Home: the attention queue and what's running now, on a phone](https://github.com/jrey8343/fabrik/issues/513)
on [Wayfinder: the Console](https://github.com/jrey8343/fabrik/issues/507).

**C was chosen.** The file opens on it, and it carries the Operator's answers and the styling they asked for. A and B are kept as the record of what was rejected; the first commit on this branch shows all three in the original styling.

Run it: open `index.html` in a browser, or serve this folder (`python3 -m http.server`) and open it on a phone.
Switch variants with the floating bar, the arrow keys, `#a` / `#b` / `#c`, or `?variant=`. The bar's second button changes the scene (Busy, Held, Clear).

Every repo, issue, pull request and figure in it is invented. Nothing talks to GitHub.

- **C, By work (chosen):** one row per piece of work with its place on the Loop, in a panel per Product repo, opened in place. The Merge-gate moves are on Review only.
- **A, One list:** one merged queue for every Product repo, verb first, Running on its own tab.
- **B, By move:** a repo switcher, runs above the queue as "Kit said / Now" cards, moves grouped by verb, a sheet over Home.
