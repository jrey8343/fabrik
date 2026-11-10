# Prototype: the Console's Gallery screen

Throwaway. This branch is never merged.

Three structurally different variants of a Product repo's Gallery, for the Decision
[Prototype the Gallery: a Product repo's Prototypes and UI evidence in one place](https://github.com/jrey8343/fabrik/issues/525)
on [Wayfinder: the Console](https://github.com/jrey8343/fabrik/issues/507).

**Chosen: D, which is A with C's flip in place for a Prototype's variants.** The file opens on it. A, B and C are kept as the record of what was judged.

Run it: open `index.html` in a browser, or serve this folder (`python3 -m http.server`) and open it on a phone.
Switch variants with the floating bar, the arrow keys, `#a` / `#b` / `#c` / `#d`, or `?variant=`. The bar's second button changes the scene: Kept 30 days, Kept 90 days, Quiet.

The repo, every issue and pull request, and every "screenshot" are invented. The screenshots are drawings the file makes, at the Kit's two sizes (390 by 844 and 1440 by 900, one screen high). Nothing talks to GitHub. The styling is the Digest prototype's, as the Spend prototype has it.

- **A, By work:** a row per Prototype and per pull request, yours first, as on Home. Merged work stays only while it has pictures. A row opens to its own screen with Before beside After per route. A Prototype's variants are stacked full size. A picture opens full screen, where Before and After flip in place and a desktop shot can be shown at its real size.
- **B, By page:** the Gallery is the Product's routes, each with how it looks in production now. A page shows everything open on it together, then its history, where merged work stays for good as a line and its pictures last as long as GitHub keeps them. Nothing opens full screen: Before and After are a wipe, desktop shots are strips dragged sideways, and a Prototype's variants are a sideways swipe or all side by side.
- **C, Roll:** every picture captured, newest first, by day, After only. Expired work drops to a list of links under the roll. A tap opens a viewer that swipes through the whole roll; hold a button for Before, double-tap for twice the size, and a Prototype's variants flip in place.

What the variants rest on, so none is judged on something the Kit can't give:

- UI evidence is captured per pull request at each push: up to a few routes, Before (public routes only) and After, at the two sizes, each one screen high. A page behind a sign-in has no Before (ADR-0012).
- A Prototype is 3 to 5 variants of one route, each with a one-line summary, a screenshot at the two sizes and a short video. No variant here plays the video.
- GitHub deletes the screenshots 30 days after capture and the Console keeps no copy. "Kept 90 days" shows the same repo if the Kit asked for GitHub's maximum.
- B's "Now" picture is the After of the newest merged change that still has pictures. The Console has no picture of production of its own.
- The choice of a Prototype's variant is made by answering the round on GitHub. Every variant only shows.
