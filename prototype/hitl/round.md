@jrey8343 **Design session, round 2 of ~3.** Settled: Q1 (one physio, one day), Q2 (five fields, no login), Q4 (no queue position). Q3 changed to an SMS via Twilio, which opens four more questions. Reply `yes` or answer by number as before.

---

❓ **Q5 - Who gets the SMS?** The **waiting patients** get it, not reception. Reception still gets the email from Q3 so they know what went out.

➡️ Yes: patients get the SMS, and reception gets a copy by email.

---

❓ **Q6 - What starts it?** Reception starts it. The waitlist email has a **"Text the waitlist about this slot"** link for each freed slot, so nothing fires on its own. Starting automatically on a cancellation would need a reliable signal from Nookal, and we haven't confirmed one exists.

➡️ Yes: reception starts it with one click. Automatic sending can come later.

---

❓ **Q7 - One at a time, or everyone at once?** **Everyone** waiting for that physio and day gets the text together, with a link to book the slot. The first to book gets it, and the link tells the others it's gone.

➡️ Yes: everyone at once, first to book wins. Offering it in turn needs timers and holds.

---

❓ **Q8 - The SMS rules**: the message names the clinic, includes "Reply STOP to opt out", and is sent only to patients who ticked a consent box when they joined. Twilio test credentials only in the Sandbox, never the live account.

➡️ Yes: identify the clinic, add opt-out and consent, test keys only.
