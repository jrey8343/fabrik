# Web push to an installed iOS PWA

Research for Decision #508 on Map #507 (Wayfinder: the Console). Researched 2026-11-10.

**Question.** Can an installed PWA on a current iPhone receive web push dependably enough that the Console needs no Tauri or Capacitor wrapper? What does installing take, how is permission asked, what is delivered when the app is closed or the phone is in a Focus, what are the delivery limits and silent-push rules, how do badge counts and deep links behave, are there regional restrictions, and what breaks on reinstall or after long disuse? The same, briefly, for Android and for desktop Chrome and Safari.

**Method.** Primary sources only: WebKit's blog and bug tracker, Apple's developer documentation, WWDC transcripts and the iOS 27 iPhone User Guide, the W3C Push API draft (dated 2026-11-09) and the WHATWG Notifications standard, MDN's browser-compat-data, web.dev and Chrome's blogs, Cloudflare's docs, Capacitor's docs. Every claim links its source. **Nothing here was tested on a device.** Reports on WebKit's tracker from people outside Apple are labelled as reports. Anything I could not confirm is in "Not verified" at the end.

"Current" means iOS 27 with Safari 27.0 (released 2026-09-17) and 27.1 (2026-10-23). ([Safari 27.0](https://webkit.org/blog/18325/webkit-features-for-safari-27-0/), [Safari 27.1](https://webkit.org/blog/18486/webkit-features-for-safari-27-1/))

## Answer in brief

**Yes: the PWA alone can carry the Console's notifications. Research does not overturn "no wrapper".** But it holds only if the Console treats a push as a nudge toward the "Needs my attention" queue, never as the record of what is owed, and meets the conditions below.

1. **Delivery is a supported, documented Apple path.** A web app added to the Home Screen gets standard Web Push through APNs, with no Apple Developer Program membership. Notifications show on the Lock Screen, in Notification Center and on a paired Apple Watch, whether or not the web app is open. Nothing in the Safari 26.0, 26.4, 27.0 or 27.1 release posts changes this.
2. **Send Declarative Web Push.** Since iOS 18.4 the Worker can send a JSON payload that iOS displays itself, with no service worker involved. That removes the two documented ways classic web push dies on iOS: the subscription being revoked when a service worker fails to show a notification, and the service worker registration being deleted. Chrome, Firefox and older Safari hand the same payload to a service worker, so the Console still ships one.
3. **Three things web push on iOS cannot do, and a wrapper could:**
   - **Break through a Focus.** A web notification cannot be marked Time Sensitive. In a Focus it is silenced unless the Operator adds the Console web app to that Focus's allowed list (a supported setting, done once per Focus).
   - **Change anything silently.** Every push must show a notification. So the Worker cannot withdraw a delivered notification or lower the badge when the Operator makes the move somewhere else. A stale notification stays until the Operator clears it; the badge corrects on the next push or the next time the Console opens.
   - **Offer buttons on the notification.** Safari supports no notification actions, so "merge" from the Lock Screen is not possible.
4. **The weak spot is the tap, not the delivery.** An open WebKit bug, with reports through October 2026 on iOS 26.6 and 26.7, says tapping a notification sometimes opens the web app without navigating to the notification's URL, for both classic and declarative push. In every one of those reports the notification itself arrived. So the Console should open on the "Needs my attention" queue, and a lost deep link then costs one tap.
5. **Subscriptions can vanish without notice.** WebKit does not fire `pushsubscriptionchange`. The Console has to check its subscription on every launch, and the Worker has to drop a subscription on a 404 or 410.
6. **A Capacitor wrapper would close exactly the gaps in point 3,** plus a native tap handler. It costs 99 USD a year, an Xcode build pipeline, and either a TestFlight build that expires every 90 days or App Store review. None of that is worth paying for a queue that is already the source of truth.

## 1. Installing

- On iOS 27 the Operator opens the site in Safari, taps Share, taps **Add to Home Screen**, turns on **Open as Web App**, and taps Add. "You can receive notifications from the web app and quit the web app like you would any app." ([iPhone User Guide, iOS 27](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27))
- There is no install prompt a page can trigger. The Console has to show its own "add me to your Home Screen" instructions when opened in a browser tab.
- Since iOS 26, "every website added to the Home Screen opens as a web app" by default, and a manifest is no longer required for that. The Operator can switch **Open as Web App** off, which makes a plain bookmark. ([Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/))
- Ship a manifest anyway, with `display: standalone`. Apple's 2023 guidance is "If you want your site to be able to use Web Push and badging on iOS, then you should use the standalone display mode", and MDN's data still records that the `Notification` interface is undefined on iOS unless the page is a Home Screen web app whose manifest has a non-default `display`. ([WWDC23 "What's new in web apps"](https://developer.apple.com/videos/play/wwdc2023/10120/), [MDN browser-compat-data, `api/Notification.json`](https://github.com/mdn/browser-compat-data/blob/main/api/Notification.json)) Whether iOS 26 and later still require the manifest for push is not verified.
- Set the manifest `id`. iOS uses it to sync Focus settings for the web app across devices; without it the `start_url` is used. ([Web Push for Web Apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [WWDC23](https://developer.apple.com/videos/play/wwdc2023/10120/))
- A Home Screen web app has "separate cookies and storage from the browser". ([WWDC23](https://developer.apple.com/videos/play/wwdc2023/10120/)) Signing in to the Console in Safari does not sign in the installed Console, and a subscription made in one does not exist in the other. The same site can be installed more than once, and "each installation has its own isolated storage and is treated as a different application". ([web.dev, Installation](https://web.dev/learn/pwa/installation))
- Other iOS browsers can also offer Add to Home Screen since 16.4. ([Web Push for Web Apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/))

## 2. Asking permission

- Only the installed web app can ask, and only "in response to direct user interaction, such as tapping on a 'subscribe' button". ([Web Push for Web Apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)) Apple's doc adds: "When the user completes the gesture, call the push subscription method immediately from the gesture's event handler code." ([Apple, Sending web push notifications](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers))
- So the Console needs a visible "Turn on notifications" button whose handler calls `subscribe()` first, before any other awaited work.
- Granting notification permission also grants badging. ([WWDC23](https://developer.apple.com/videos/play/wwdc2023/10120/))
- The Operator manages the permission per web app in iOS Settings, under Notifications, like any app. ([Web Push for Web Apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/))
- "You do not need to be a member of the Apple Developer Program." ([Web Push for Web Apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/))

## 3. What is delivered, and when

**App closed.** Notifications "show on the Lock Screen, in Notification Center, and on a paired Apple Watch." ([Web Push for Web Apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)) Badges, too, "can be updated when the web app is open and when push events are being handled in the background." ([WWDC23](https://developer.apple.com/videos/play/wwdc2023/10120/)) The field reports in section 6 all say the notification arrived in every app state they tried: open, backgrounded, and swiped away.

**Phone offline.** The sender sets a `TTL`. "If the push service can't deliver a notification immediately, it may store the notification for 30 days or fewer", and "The number of notifications the push services stores while the device is offline is limited." ([Apple, Sending web push notifications](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)) Apple's doc for native APNs is blunter: it "stores only one notification per bundle ID", and notifications "may also get throttled, saved in storage, and in some cases, not delivered." ([Apple, Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)) Whether the one-per-app rule applies to a web push subscription is not verified. Either way: after a flight, expect one notification, not ten.

**In a Focus.** Web app notifications "integrate with Focus". ([Web Push for Web Apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)) The iOS 27 User Guide says, under allowing or silencing apps in a Focus: "You can allow or silence notifications from specific web apps you've added to your Home Screen." ([iPhone User Guide, Focus](https://support.apple.com/guide/iphone/allow-or-silence-notifications-for-a-focus-iph21d43af5b/ios)) So:

- If the Console is on a Focus's allowed list, its notifications come through in that Focus.
- If it is not, they are silenced until the Focus ends.
- A native app can mark a notification `time-sensitive`, which "can break through system controls such as Notification Summary and Focus". ([Apple, `timeSensitive`](https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/timesensitive)) Web push has no such field: Apple's web push doc lists only the `TTL`, `Topic` and `Urgency` headers, and neither the Push API's declarative message nor the Notifications API has an interruption level. ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers), [Push API §3.3](https://www.w3.org/TR/push-api/), [Notifications standard](https://notifications.spec.whatwg.org/))
- iOS 27 adds "Intelligent Breakthrough & Silencing", where Apple Intelligence decides which notifications interrupt a Focus. ([iPhone User Guide, Focus](https://support.apple.com/guide/iphone/allow-or-silence-notifications-for-a-focus-iph21d43af5b/ios)) How it treats web app notifications is not verified.

**What a notification can carry on iOS.** Title, body and a URL to open. MDN's data marks these as unsupported in Safari on iOS: `actions` (buttons), `image`, `badge` (the small icon), `requireInteraction`, `renotify`, `vibrate`, and `tag` ("can be set, but has no effect" on macOS Safari, unsupported on iOS). ([MDN browser-compat-data, `api/Notification.json`](https://github.com/mdn/browser-compat-data/blob/main/api/Notification.json)) Without a working `tag`, a second notification about the same pull request does not replace the first. The `Topic` header only replaces a message still waiting at the push service. ([web.dev, Web Push protocol](https://web.dev/articles/push-notifications-web-push-protocol))

## 4. Delivery limits and silent-push rules

**Every push must show a notification.** "Safari doesn't support invisible push notifications. Present push notifications to the user immediately after your service worker receives them. If you don't, Safari revokes the push notification permission for your site." ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)) WebKit: "if an event handler doesn't show the user visible notification for any reason we revoke its push subscription", and the reasons include "bugs in a service worker script, networking conditions, or local device conditions". ([Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)) In 2022 Apple put the tolerance at three failures, in the macOS Ventura beta; no current document gives a number. ([WWDC22 "Meet Web Push for Safari"](https://developer.apple.com/videos/play/wwdc2022/10098/))

**Declarative Web Push takes that risk away.** Shipped in iOS and iPadOS 18.4 for Home Screen web apps and in Safari 18.5 on macOS. ([Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/), [WWDC25 "Learn more about Declarative Web Push"](https://developer.apple.com/videos/play/wwdc2025/235/)) The push body is JSON the system displays itself:

```json
{
  "web_push": 8030,
  "notification": {
    "title": "Ready to merge: a pull request title",
    "body": "One line saying what is owed",
    "navigate": "https://console.example/attention",
    "app_badge": "3"
  }
}
```

- `web_push: 8030`, `notification.title` and `notification.navigate` are required. ([Push API §3.3](https://www.w3.org/TR/push-api/))
- "Unlike with original Web Push, there is no penalty for service workers failing to display a notification." ([Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/))
- It does not need a service worker at all: `window.pushManager` exists for subscribing, and "the removal of that service worker registration will not affect the associated push subscription." ([Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/))
- It is backwards compatible. "If it arrives to an older browser, it's handled imperatively by JavaScript as it always had been." ([Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)) MDN's data shows `window.pushManager` in Safari 18.4 only, not Chrome or Firefox, so those browsers need a `push` handler in a service worker that reads the same JSON and calls `showNotification()`. ([MDN browser-compat-data, `api/Window.json`](https://github.com/mdn/browser-compat-data/blob/main/api/Window.json))
- Leave `mutable` out. With `mutable: true` the service worker gets a chance to replace the notification, which brings back the code path the format exists to avoid. ([WWDC25](https://developer.apple.com/videos/play/wwdc2025/235/))
- The format is now in the W3C Push API draft of 2026-11-09, which calls it "a backup in case the service worker was evicted due to storage pressure". ([Push API §3.3](https://www.w3.org/TR/push-api/))
- A malformed declarative payload that has the magic key is dropped silently: "the browser simply does nothing". ([WWDC25](https://developer.apple.com/videos/play/wwdc2025/235/)) The Worker should build the payload from one tested function.

**Sender-side limits, from Apple's doc** ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)):

| Rule | Detail |
|---|---|
| Payload | 4 KB at most (`PayloadTooLarge`, HTTP 413). |
| `TTL` | Must be present and positive, or the request fails with `BadTtl`. Storage is 30 days at most. |
| `Urgency` | `very-low`, `low`, `normal` or `high`. "To attempt to deliver the notification immediately, specify `high`." |
| `Topic` | Optional, up to 32 URL-safe Base64 characters; the push service uses it to coalesce pending notifications. |
| VAPID | The JWT's public key must match the one given to `subscribe()`. "Don't refresh your JWT more frequently than once per hour." Expiry at most one day ahead. |
| Rate | HTTP 429 `TooManyRequests`: "too many consecutive requests to the same device token." No number is published. |
| Dead subscription | HTTP 410: "The device token has expired." |
| Network | Endpoints are under `*.push.apple.com`. |

**No delivery receipt.** A 201 means the push service accepted the message, not that the phone showed it. The Push API draft says it "will also ensure reliable delivery of push messages while a user agent is actively using a web application", and also that an application server "could incorrectly receive a delivery receipt indicating successful delivery". ([Push API](https://www.w3.org/TR/push-api/)) No primary source publishes a delivery rate for web push on iOS.

## 5. Badge counts

- `navigator.setAppBadge(n)` and `clearAppBadge()` work in Home Screen web apps since 16.4, from the page and from a service worker. `setAppBadge(0)` clears. ([Badging for Home Screen Web Apps](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/))
- "The badge will only appear if the user has granted notifications permission." The Operator can leave notifications on and turn the badge off in Settings, and "we never expose this user preference to the web app." ([Badging](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/))
- **No badge-only push.** "A badge update by itself does not fulfill the 'user visible' requirement." ([Badging](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/))
- A declarative push can carry `app_badge` alongside its notification. ([Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)) This member is WebKit's: it is not in the W3C draft's member list. ([Push API §3.3](https://www.w3.org/TR/push-api/)) One report from September 2026 says `app_badge` "was not applied on our device" (iOS 26.7.1). ([WebKit bug 268797, comment 39](https://bugs.webkit.org/show_bug.cgi?id=268797#c39))
- What this means for the Console: the badge can go **up** with each push, and is set **exactly** whenever the Console is opened. It cannot go **down** while the Console is closed, for example when the Operator merges from a desktop.

## 6. Deep-linking a notification to a screen

Two mechanisms, both with open problems:

- **Classic push:** the service worker's `notificationclick` handler calls `clients.openWindow(url)` or `client.navigate(url)`.
- **Declarative push:** the system navigates to `notification.navigate` with no JavaScript. ([WWDC25](https://developer.apple.com/videos/play/wwdc2025/235/))

[WebKit bug 268797](https://bugs.webkit.org/show_bug.cgi?id=268797), "notificationclick events in serviceworkers not firing", was filed in February 2024, is still `NEW`, has a radar attached, and was last modified 2026-11-02. What it holds:

- WebKit engineers (2024): the event does fire, but "some Clients and WindowClient methods resolve too early". They split out [279458](https://bugs.webkit.org/show_bug.cgi?id=279458) (fixed, October 2024) and [279456](https://bugs.webkit.org/show_bug.cgi?id=279456) (`Clients.openWindow` resolving too early, still `NEW`). An earlier bug of the same family, [252544](https://bugs.webkit.org/show_bug.cgi?id=252544), was fixed in 2023.
- Report, August 2026 (iOS 18.7): with no live page, tapping a classic notification brings the web app forward but never dispatches `notificationclick`. The same report: declarative push "is stable in the same PWA states".
- Report, September 2026 (iOS 26.6.1): a declarative `navigate` works when the web app was terminated or is in front, and is **lost** when the web app was backgrounded and the phone had slept; the existing window is restored at whatever screen it was on.
- Report, September 2026 (iOS 26.7.1): a plain `notificationclick` handler worked reliably once the tester ruled out a stale service worker. iOS "kept running an outdated service worker for a long time after the script had changed". The same tester saw declarative navigation fail when the app was already running.
- Report, October 2026 (iOS 26.6.2), with a test case attached: `notificationclick` fired only when the tap launched the web app from a swiped-away state.

These reports disagree with each other about which state fails, and none is confirmed by WebKit. What they agree on is that **the push arrived and the tap opened the web app**. The safe reading: a tap reliably opens the Console; it does not reliably open a given screen.

MDN's data lists `notificationclick` as unsupported in Safari on iOS. ([MDN browser-compat-data, `api/ServiceWorkerGlobalScope.json`](https://github.com/mdn/browser-compat-data/blob/main/api/ServiceWorkerGlobalScope.json)) That conflicts with WebKit's engineers on the bug above, who say it fires. I trust the tracker over the table, but the table shows how shaky this corner is.

## 7. Regional restrictions

- **European Union.** In February 2024 Apple announced it would remove Home Screen web apps in the EU with iOS 17.4, then reversed before release. Apple's page [Update on apps distributed in the European Union](https://developer.apple.com/support/dma-and-apps-in-the-eu/) carried that statement in 2024; today it says nothing about Home Screen web apps at all, and neither does [Using alternative browser engines in the European Union](https://developer.apple.com/support/alternative-browser-engines/). I found no current Apple statement restricting them. The 2024 episode is recalled from Apple's text at the time and from press coverage, not re-read on a live Apple page.
- **Elsewhere.** No Apple or WebKit document I read names a regional restriction on web push.
- **Shared iPad.** Add to Home Screen is not offered on an iPad configured as a Shared iPad. ([Web Push for Web Apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)) Not relevant to one Operator's iPhone.

## 8. What breaks on reinstall, on update, and after long disuse

**Removing and re-adding the web app.** Each installation has its own storage, so a re-added Console is a new app: signed out, no notification permission, no subscription. The Operator signs in and taps "Turn on notifications" again; the Worker ends up with a dead endpoint (which will return 410) and a new one. Whether removing the icon deletes the old data is not stated by Apple; web.dev says of PWAs in general: "Deleting the icon may not clear the storage that a PWA is using." ([web.dev, Installation](https://web.dev/learn/pwa/installation))

**Losing the subscription with no action by the Operator.** [WebKit bug 273063](https://bugs.webkit.org/show_bug.cgi?id=273063) (`NEW`, radar attached, last touched July 2024) reports subscriptions "sometimes being revoked outside of user interaction". A WebKit engineer replied that a number of such bugs had been fixed for iOS 17.5, in the system's web app host rather than in WebKit: it "would handle the push, but then tell WebKit that the website didn't have permissions anymore, which would then result in the subscription being deleted." The same reply confirms: "We don't fire PushSubscriptionChangeEvent." A later comment reports having to resubscribe after updating to iOS 17.6. MDN's data agrees that `pushsubscriptionchange` is unsupported on iOS. ([MDN browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/ServiceWorkerGlobalScope.json)) The Push API says the event exists precisely for a subscription that "has been refreshed, revoked or lost". ([Push API §10.4](https://www.w3.org/TR/push-api/)) On iOS the Console gets no such signal.

**Long disuse.**

- Intelligent Tracking Prevention deletes a site's script-writable storage, including service worker registrations, after seven days of Safari use without interaction. Home Screen web apps "are not part of Safari and thus have their own counter of days of use", and "we do not expect the first-party in such a web application to have its website data deleted." ([Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/))
- WebKit can also evict an origin's data "when the system is under storage pressure, or when the site has not been interacted with by the user for some time". Origins in persistent mode are excluded, and WebKit grants `navigator.storage.persist()` "based on heuristics like whether the website is opened as a Home Screen Web App". ([Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/))
- Even if the service worker registration is deleted, a subscription made through `window.pushManager` survives, and a declarative push is still displayed. ([Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/), [WWDC25](https://developer.apple.com/videos/play/wwdc2025/235/))
- Apple publishes no lifetime for a web push subscription. The only signal is the 410 the Worker gets when it next sends.

**Stale service worker.** The September 2026 report in section 6 found iOS running an old service worker until the web app was fully closed. With declarative push the service worker is not on the iOS delivery path, so this matters less.

## 9. Sending from the Cloudflare Worker

- Cloudflare's only first-party guide to sending web push is in the Agents SDK docs. It uses the `web-push` npm package, requires the `nodejs_compat` flag, keeps the VAPID keys as Wrangler secrets, and says: "Always handle 404 and 410 responses from the push service by removing the dead subscription from state." It suggests retrying 5xx after a delay. It says nothing about iOS. ([Cloudflare, Push notifications](https://developers.cloudflare.com/agents/communication-channels/webhooks/push-notifications/))
- A plain Worker can also do it with no library: Workers' Web Crypto supports ECDSA, ECDH, HKDF and AES-GCM, which is what VAPID and the payload encryption need. ([Cloudflare, Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/))
- Whichever is used must respect Apple's rule not to mint a new VAPID JWT more than once an hour. Whether `web-push` reuses a JWT across sends is not verified; check before adopting it.
- The Worker stores subscriptions, not messages. A lost subscription store is rebuilt by the Console re-subscribing on its next launch, which fits "anything the Console stores is a cache".

## 10. Android, desktop Chrome, desktop Safari

| | Android (Chrome) | Desktop Chrome | Desktop Safari (macOS) |
|---|---|---|---|
| Install needed for push | No. Installing makes a WebAPK. ([web.dev](https://web.dev/learn/pwa/installation)) | No. | No (Safari 16, macOS 13 and later). Web apps added to the Dock also get push. ([Meet Web Push](https://webkit.org/blog/12945/meet-web-push/), [WWDC23](https://developer.apple.com/videos/play/wwdc2023/10120/)) |
| Delivered when the browser is closed | Yes. Android wakes the browser for a push. ([web.dev FAQ](https://web.dev/articles/push-notifications-faq)) | Only while Chrome is running. "The only time a push won't be received is when the browser is completely closed." ([web.dev FAQ](https://web.dev/articles/push-notifications-faq)) | Yes. "Safari doesn't even need to be running." ([Meet Web Push](https://webkit.org/blog/12945/meet-web-push/)) |
| Declarative Web Push | No. The service worker handles the same JSON. ([MDN data](https://github.com/mdn/browser-compat-data/blob/main/api/Window.json)) | No, same. | Yes, Safari 18.5. ([WWDC25](https://developer.apple.com/videos/play/wwdc2025/235/)) |
| Notification buttons (`actions`) | Yes. | Yes. | No. ([MDN data](https://github.com/mdn/browser-compat-data/blob/main/api/Notification.json)) |
| `tag` replaces an earlier notification | Yes. | Yes. | No effect. ([MDN data](https://github.com/mdn/browser-compat-data/blob/main/api/Notification.json)) |
| App badge | No `setAppBadge` on Android. | Yes for an installed PWA on Windows and macOS. | Yes for Dock web apps, Safari 17. ([MDN data, `api/Navigator.json`](https://github.com/mdn/browser-compat-data/blob/main/api/Navigator.json)) |
| `pushsubscriptionchange` | Chrome 138 and later. | Same. | Yes on macOS, since Safari 16. ([MDN data](https://github.com/mdn/browser-compat-data/blob/main/api/ServiceWorkerGlobalScope.json)) |
| Silent push | Not allowed either: "Other browsers all have countermeasures against violating the promise to make pushes user visible." ([WWDC22](https://developer.apple.com/videos/play/wwdc2022/10098/)) | Same. | Not supported; the permission is revoked. ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)) |

Two Chrome policies to know, neither a threat to the Console: Chrome removes notification permission from sites with "very low user engagement and a high volume of notifications", but "does not revoke notifications for any installed web apps" ([Chromium blog, October 2025](https://blog.google/chromium/automatic-notification-permission/)); and Chrome rate-limits push from sites it flags as disruptive, answering excess sends with HTTP 429 ([Chrome for Developers, January 2026](https://developer.chrome.com/blog/web-push-rate-limits)). Installing the Console on Android and using it puts it outside both.

## 11. Conditions the Console must meet

1. **The queue is the truth; a push is a nudge.** "Needs my attention" must be correct with every notification lost. This is already Map setting 7.
2. **Open on the queue.** The installed Console's `start_url` and every notification's `navigate` land on, or one tap from, "Needs my attention". A lost deep link is then harmless.
3. **Ship a manifest** with `display: standalone`, a stable `id`, and icons.
4. **Show install instructions** when opened in a browser tab on iOS, since only the Home Screen web app can subscribe.
5. **Ask from a button.** A "Turn on notifications" control whose tap handler calls `subscribe()` immediately.
6. **Send declarative payloads,** without `mutable`, and keep a service worker `push` handler that renders the same JSON for Chrome and Firefox. That handler must show a notification on every push, with no awaited network call before it.
7. **Reconcile on every launch.** Call `getSubscription()`; if it is missing or its endpoint differs from what the Worker holds, re-register. Show a plain "notifications are off on this phone" state when permission or subscription is gone.
8. **Prune on 404 and 410** in the Worker, and treat 201 as "accepted", not "seen".
9. **Send with** a positive `TTL` (hours, not days: a stale nudge is noise), `Urgency: high`, a payload well under 4 KB, and a VAPID JWT cached for at least an hour.
10. **Set the badge from the page on every open** to the queue's length, and send `app_badge` with each push as a best effort. Accept that it lags while the Console is closed.
11. **Never plan a silent push.** No "clear that notification", no badge-only update, no background refresh by push.
12. **Tell the Operator once** to allow the Console in each Focus where pull requests should interrupt.
13. **Call `navigator.storage.persist()`** in the installed Console.
14. **Add a "Send a test notification" control.** With no delivery receipt and no `pushsubscriptionchange`, this is the only way to prove the whole path on a given day.
15. **Send few notifications.** One per item entering the queue, not one per event. It keeps clear of the undocumented 429 limit and of offline storage that may keep only the latest.

## 12. What a Capacitor wrapper would close, and what it costs

A wrapper makes the Console a native app that registers with APNs directly; the Capacitor push plugin returns "the APNS token" and reports taps through `pushNotificationActionPerformed`. ([Capacitor, Push Notifications](https://capacitorjs.com/docs/apis/push-notifications)) The Worker would then send native APNs payloads. That closes:

| Gap in the PWA | What native adds | Source |
|---|---|---|
| Cannot break through a Focus | `interruption-level: time-sensitive` in the payload | [Apple, Generating a remote notification](https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification) |
| No silent changes | `content-available: 1` background pushes, to clear a delivered notification or correct the badge when the move was made elsewhere | Same. **But** the Capacitor plugin "does not support iOS Silent Push (Remote Notifications)" and recommends native code for it. ([Capacitor](https://capacitorjs.com/docs/apis/push-notifications)) |
| No buttons on a notification | Notification categories with actions | [Apple](https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification) |
| Tap may not deep-link | A native tap callback carrying the payload | [Capacitor](https://capacitorjs.com/docs/apis/push-notifications) |
| Subscription lost without a signal | An APNs device token under the app's control, re-read at every launch | [Capacitor](https://capacitorjs.com/docs/apis/push-notifications) |

It does **not** close: delivery when the phone is off or offline (same APNs storage rules), or the Operator turning notifications off.

What it costs:

- Apple Developer Program membership, "99 USD per membership year". ([Apple](https://developer.apple.com/programs/whats-included/)) A free account's provisioning profiles expire after 7 days. ([Apple, Compare memberships](https://developer.apple.com/support/compare-memberships/))
- A build and signing pipeline in Xcode, which needs a Mac or a macOS runner (general knowledge, not sourced here).
- Distribution: a TestFlight build "becomes unavailable for testers after 90 days" ([Apple, TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)), so the Operator re-uploads at least quarterly, or the app goes through App Store review.
- A second notification path in the Worker (APNs token auth and payloads) beside web push for Android and desktop.

For one Operator and a queue that is already the record, the only gap that might ever justify this is Focus breakthrough, and the Focus allowed list covers it.

## Not verified

- **No device test.** Nothing above was run on an iPhone. A week of the prototype on the Operator's own phone, with the "test notification" control, would turn the field reports in section 6 into first-hand facts.
- **Delivery rate.** No primary source gives one for web push on iOS.
- **Whether iOS 26 and later still require a manifest with `display: standalone` for push,** now that any site added to the Home Screen opens as a web app.
- **Whether APNs' "one stored notification per bundle ID" applies to a web push subscription.** Apple's web push doc says only that storage "is limited".
- **How iOS 27's Intelligent Breakthrough & Silencing and Notification Summary treat web app notifications.**
- **Whether removing the Home Screen icon deletes the web app's data.**
- **The current EU position.** No live Apple page states it either way.
- **The Content-Type a declarative push needs,** if any. WebKit's post does not say.
- **Whether the `web-push` library reuses its VAPID JWT** within Apple's one-hour rule.
- **Safari 26.1 to 26.3 and 26.5 to 26.7 release posts** were not read. The 26.0, 26.4, 27.0 and 27.1 posts were, and none mentions a change to web push or Home Screen notifications.
- **The 2026 comments on WebKit bug 268797** are reports from developers outside Apple. WebKit has confirmed none of them.
