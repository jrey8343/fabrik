<!--
An example Vision, for a made-up product. Fabrik's Loop never reads this file: the only Vision it reads is `docs/product/vision.md` at a Product repo's root. To write yours, copy this file there and rewrite every line.

The Vision is optional, and only you, the Operator, change it. It's a Trust-root file, so the push job refuses any agent branch that touches `docs/product/`: edit it yourself, or in a Pairing session, through a pull request you merge.

It's free prose with no schema, so the headings below are a suggestion, not a format the Kit parses. Keep it short enough to read before every Design session: a page is plenty.
-->

# Vision

<!--
Who the product serves: a short paragraph per kind of End user. An End user is a person the product serves, never you. Say who they are, where the product meets their day, and what they care about, so a Design session can tell which of them an issue serves.
-->

## Who it serves

**Clinic owners** run a physiotherapy practice of one to five rooms, and most still treat patients themselves between running the front desk. They set the opening hours, the treatments and the prices, and they check the day's bookings on a phone between appointments. They care about a full calendar, and about never answering the phone mid-treatment.

**Patients** book a treatment with one clinic they already know, usually on a phone and often outside opening hours. Most book the same treatment again every week or two. They care about getting a time that fits, and about hearing straight away when it changes.

<!--
The problem the product solves for them, in their terms rather than as a list of features. A Design session asks why a change matters against this.
-->

## The problem it solves

A cancelled appointment leaves a gap the clinic owner can rarely fill: by the time they've rung round, the slot has passed. The patients who wanted that time never hear that it came free, and they can only book by phone while the clinic is open.

<!--
How success is measured: one measure you'd look at to know the product is working. A Spec states it, and Fabrik never tracks it, so write something you could check by hand.
-->

## How we know it's working

Most cancelled slots are booked again before they start: at least 7 in 10, counted over a month.

<!--
What the product deliberately doesn't do. This is the only place for it, since the Roadmap holds no "Not doing" list. Write each as one line, so it can be quoted when an idea conflicts with it.
-->

## What it deliberately doesn't do

- It takes no payments. Clinics already charge through their own card reader.
- It holds no clinical notes, and nothing else about a patient's health.
- It's no marketplace: a patient only ever sees the clinic they book with.
- It asks patients to install nothing. Booking works from a link in a browser.
