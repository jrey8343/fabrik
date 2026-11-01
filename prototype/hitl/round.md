@jrey8343 **Design session, round 3 of 3: the last two questions, then the draft for you to confirm.** Reply `yes` to take both recommendations and confirm the draft, or say what's wrong.

---

❓ **Q9 - Patients who are too slow**: the link shows "Someone beat you to it", and they **stay on the list** for that day.

➡️ Yes: they stay on, with no follow-up text.

---

❓ **Q10 - When an entry ends**: when they book any slot that day, reply STOP, or the day passes.

➡️ Yes: those three, nothing manual.

---

### Draft Spec (confirm with `yes`)

- When the patient's physio is fully booked that day, the booking page offers **Join waitlist**: name, mobile, email, morning/afternoon/any, and an SMS consent box. The confirmation says "We'll text you if a spot opens", with no queue position.
- Reception gets an email per freed slot listing who's waiting, with a **Text the waitlist about this slot** link.
- One click texts everyone waiting for that physio and day: the clinic's name, a booking link, and "Reply STOP to opt out" (Twilio). Reception gets a copy.
- The first to book wins. Everyone else sees "taken" and stays on the list.
- Entries end on booking, STOP, or end of day. Twilio test credentials only in the Sandbox.

Likely Tickets: join form and waitlist store · reception email with the send link · Twilio fan-out with opt-out · booking-link landing page (book / taken) · end-of-day expiry.
