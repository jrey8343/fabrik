# GitHub's 2026 changes to redirect matching and refresh tokens, and the Console's sign-in

Research for Decision #567 on the Wayfinder Map #507. It hangs on #517 (which credential the Console holds) and #544 (what the Console's Worker keeps).

**Question.** The Console will register its own private GitHub App, owned by a personal account, with expiring user access tokens. It signs the Operator in through GitHub's web redirect flow with `state` and PKCE, device flow off, no private key, and its Worker keeps one access-and-refresh token pair. Two GitHub changelog entries from 2026 were seen only in summary. Does either change what the sign-in request must send or what the App's registration must say?

Everything below was read on 2026-11-11 from GitHub's own changelog and docs. Nothing was tried against a live App.

## Answer in brief

1. **Redirect matching (14 August 2026): one thing to check in the registration, nothing to add to the sign-in.** Wildcard matching is now a per-callback-URL setting on a GitHub App. With it off, "the redirect URL must exactly match the callback URL". With it on, any subdomain of the callback's host and any deeper path under the callback's path is accepted. The Console's registration must have wildcard matching **off** on its one callback URL. The docs tie the switched-on-by-default state to Apps that had a single callback URL "prior to August 3, 2026", so an App registered now should start with it off, but no page states the default for a new App in so many words. So: look at the setting once, after registering, and switch it off if it is on.
2. **`offline_access` (13 October 2026): nothing is required.** A GitHub App whose registration has token expiration on (the default for a new App) still gets a refresh token from the web flow without asking for anything. `offline_access` is a per-sign-in opt-in for Apps that have expiration switched **off**. The Console's registration must leave **Expire user authorization tokens** selected, which #517 already assumes. Sending `scope=offline_access` is optional and, on the docs' wording, redundant for this App.
3. **The four docs pages agree with both entries.** "Registering a GitHub App" was not changed by either: it mentions neither wildcard matching nor `offline_access`.

## How it was read

- Both changelog pages and every docs page were fetched whole and read as text, not summarised by a model. The docs pages were also checked against their source in the public `github/docs` repository, including the two commits that made the changes: `74d2d500a6` ("Wildcard and multiple redirect URIs for Apps", 14 August 2026) and `d1a3effbeb` ("GitHub Apps updates omnibus", 7 October 2026).
- Each changelog entry links a GitHub Community discussion that carries the announcement and replies from its author. Those replies are quoted in two places below and marked as forum replies. They are weaker than the changelog and the docs.
- Passages in quotation marks are verbatim.

## 1. Wildcard redirect matching (changelog of 14 August 2026)

Source: [Multiple redirect URIs and token refresh for OAuth apps](https://github.blog/changelog/2026-08-14-multiple-redirect-uris-and-token-refresh-for-oauth-apps/).

Most of the entry is about OAuth apps (expiring tokens, up to 10 redirect URIs). GitHub Apps already had both. The one part that reaches a GitHub App is the last section.

### What the changelog says

> OAuth apps and GitHub Apps can now enable wildcard matching for each redirect URI configured. This can allow redirects to multiple related sites (e.g., tenanted subdomains of your app) without registering a redirect URI per tenant.
>
> When enabled, wildcard matching allows an authorization code (and user) to be sent from GitHub to any URL that matches a subdomain or additional path off of the redirect URI.

> Apps with only one redirect URI have wildcard matching enabled. This is a legacy behavior of GitHub that is now visible and controllable. Please review your apps and disable wildcard matching if you do not need it. This applies to all OAuth apps and any GitHub App that had a single redirect URI registered.

So the entry did not switch anything on. It made an old, hidden behaviour visible and gave it an off switch.

### What the docs say

Source: [About the user authorization callback URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url#wildcard-matching-for-callback-urls), section "Wildcard matching for callback URLs".

The rule when it is on:

> If required, you may enable wildcard matching for a callback URL. When wildcard matching is enabled, the redirect URL's host (excluding subdomains) and port must exactly match the callback URL, and the redirect URL's path must reference a subdirectory of the callback URL. This means that any subdomain or subdirectory of the callback URL will match and be allowed as a callback URL.

The page's own example, for the callback URL `https://example.com/path`:

```
MATCH: https://example.com/path
MATCH: https://example.com/path/subdir/other
MATCH: https://oauth.example.com/path
MATCH: https://oauth.example.com/path/subdir/other
FAIL:  https://example.com/bar
FAIL:  https://example.com/
FAIL:  https://example.com:8080/path
FAIL:  https://oauth.example.com:8080/path
FAIL:  https://example.org
```

The rule when it is off, and where the switch is:

> When wildcard matching is disabled, the redirect URL must exactly match the callback URL. You can enable or disable wildcard matching for each callback URL in your app's settings.

Which Apps have it on:

> Apps that had a single callback URL enabled prior to August 3, 2026 have wildcard matching enabled for that callback URL. This preserves the redirect behavior that existed before wildcard matching became a configurable setting, and is why all OAuth apps and some GitHub Apps created before that date have wildcard matching enabled. If your app does not need wildcard matching, we recommend that you disable it.

The warning, repeated in [Best practices for creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app#enable-wildcard-matching-for-callback-urls-only-when-necessary) under "Enable wildcard matching for callback URLs only when necessary":

> Enabling wildcard matching can expose your app to security risks, because it allows an attacker to send authorization codes to any subdomain or subdirectory of the callback URL. Only enable wildcard matching if you absolutely need it and you are entirely certain that you control all possible subdomains and paths of the callback URL.

The same August commit changed the `redirect_uri` row in [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-web-application-flow-to-generate-a-user-access-token) from "This must be an exact match to one of the URLs" to:

> This must be a match to one of the URLs you provided as a "Callback URL" in your app's settings and can't contain any additional parameters.

A `redirect_uri` that does not match is refused. The same page, under "Troubleshooting": "If you specify a `redirect_uri` that doesn't match one of the callback URLs in your GitHub App registration, you will receive a `redirect_uri_mismatch` error."

### What it does to the Console's App

- **With wildcard matching off, a sign-in returns only to the one exact callback URL.** Documented.
- **With it on, a sign-in could return elsewhere, but only within limits.** Documented by the rule and the example above: a `redirect_uri` on any subdomain of the callback URL's host, or at any deeper path beneath the callback URL's path, on the same port. Never another host and never a sibling or parent path.
- **The protection is in the registration, not in what the Console sends.** Inferred: `redirect_uri` is a parameter of the authorise link, and the App's client id is not a secret, so anyone can build a link that names another matching URL. What the Console itself sends does not narrow what GitHub will accept.
- **Whether a new App starts with it on is not stated outright.** The docs give a cut-off ("prior to August 3, 2026"), say "some GitHub Apps created before that date" have it on, and open with "If required, you may enable". Read together, an App registered after that date starts with it off. That reading is an inference. The changelog's sentence "Apps with only one redirect URI have wildcard matching enabled" has no date in it, and the Console's App will have exactly one.
- **Owner, visibility, expiring tokens and PKCE make no difference here.** Neither the changelog nor the docs tie redirect matching to who owns the App, whether it is private, or how its tokens are issued.

### What the registration and the sign-in must include

**Registration:** one callback URL, with wildcard matching disabled on it. After registering, open the App's settings and confirm it.

- The docs name where the switch is ("for each callback URL in your app's settings") but not its label. The registration steps in [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) (step 9, "Callback URL") do not mention it.
- The state can be read only in the settings page. In the discussion the changelog links, asked whether it is readable outside the settings UI, the announcement's author replied that registration-management APIs are "on our near-term backlog but no concrete dates to share just yet" ([forum reply, 9 September 2026](https://github.com/orgs/community/discussions/204963)).
- The manifest route has no key for it either: [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) lists `callback_urls` and nothing about wildcard matching.

**Sign-in request:** nothing new. Unchanged advice that still applies:

- `redirect_uri` is "Strongly recommended" on the authorise request. With one callback URL registered, leaving it out has the same result: "If you do not specify a `redirect_uri`, the first callback URL will be used" ([callback URL page](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)). If the Console sends it, it sends the registered URL character for character, with no added query parameters, and the same value on the code exchange.
- `state`, `code_challenge` and `code_challenge_method` (`S256` only) are each "Strongly recommended", as #544 already has them.

## 2. The `offline_access` scope (changelog of 13 October 2026)

Source: [GitHub App improvements for least privilege and management](https://github.blog/changelog/2026-10-13-github-app-improvements-for-least-privilege-and-management/), section "Use `offline_access` with GitHub Apps to gradually reenable short-lived, rotating tokens".

### What the changelog says

> GitHub Apps now support the `offline_access` scope, like OAuth apps. While GitHub Apps use short-lived, rotating tokens by default, some developers have disabled expiration for convenience and now struggle to reenable it.
>
> This support helps app developers gradually migrate to expiring user access tokens. Developers can enable token expiration for testing and rollout without having to switch every user to expiring tokens at the same time, which would break existing clients.
>
> When `offline_access` is requested, the app receives a refresh token in addition to the expiring access token. It only changes that specific authentication and doesn't impact future sessions.
>
> The `scope` parameter is still otherwise unused for GitHub Apps—permissions are still statically selected on the application registration.

The summary that prompted this Decision read the third paragraph alone, as if the scope governed whether a refresh token is issued at all. In context it is an extra way to get one, for Apps that have expiration switched off.

### What the docs say

Source: [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).

A refresh token comes from the App's own setting:

> If your app uses user access tokens that expire, then you will receive a refresh token when you generate a user access token. The user access token expires after eight hours, and the refresh token expires after six months.

That setting is on for a new App:

> When you create your app, expiration of user access tokens is enabled unless you opt out.

`offline_access` is the exception for Apps that opted out:

> To test and gradually roll out support for expiring tokens, you can opt in for an individual user authorization by requesting the `offline_access` scope. When you request `offline_access`, you will receive an expiring user access token and a refresh token even if your app is configured not to use expiring user access tokens.
>
> The `scope` parameter does not grant permissions to a GitHub App. The only supported value is `offline_access`, which forces the user access token to expire.

[Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) says the same in three places:

- The web flow's `scope` parameter is **Optional**: "To receive an expiring user access token and a refresh token for this authorization, set this value to `offline_access`. No other scopes are supported for GitHub Apps. This parameter does not control permissions for the user access token."
- Under "Using a refresh token to generate a user access token": "By default, user access tokens expire after 8 hours. If you receive a user access token with an expiration, you will also receive a refresh token."
- Under "Bad refresh token": "You will only receive a refresh token if your GitHub App has opted in to expiring user access tokens or uses the `offline_access` scope." Before the October commit this sentence ended at "expiring user access tokens". The change added a second way, and took nothing from the first.

[Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), step 10, is unchanged:

> Optionally, to prevent user access tokens from expiring, deselect **Expire user authorization tokens**. GitHub strongly recommends that you leave this option selected.

### What it does to the Console's App

- **The web flow does not have to ask for `offline_access`.** Documented: with expiration on in the registration, the token response carries `refresh_token`, `expires_in` (always `28800`) and `refresh_token_expires_in` (always `15897600`).
- **An App registered today gets a refresh token without it,** so long as **Expire user authorization tokens** is left selected. Documented, as above.
- **The refresh itself is unchanged.** `POST https://github.com/login/oauth/access_token` with `client_id`, `client_secret` ("Required unless the user access token was generated using the device flow"), `grant_type=refresh_token` and `refresh_token`. "Once you use a refresh token, that refresh token and the old user access token will no longer work."
- **The token still carries no scopes.** The response's `scope` "will always be an empty string", and permissions still come from the registration.

### What the registration and the sign-in must include

**Registration:** leave **Expire user authorization tokens** selected. After registering, the same setting is "User-to-server token expiration" under the App's **Optional Features**. Nothing else.

**Sign-in request:** nothing. Two options the docs allow, neither required:

- **Send `scope=offline_access` anyway.** Documented effect: that one sign-in yields an expiring token and a refresh token "even if your app is configured not to use expiring user access tokens". For the Console it would only matter if the registration's setting were ever switched off by mistake. Whether it changes what the Operator sees on GitHub's authorise page is not documented.
- **Check the response.** The docs' own test for an expiring token: "check for the `expires_in` field in the token response". A Console that refuses to store a token that arrives without `expires_in` and `refresh_token` would catch the same mistake without sending anything. This is a suggestion, not something a source asks for.

## How the four docs pages read now

| Page | Redirect matching | Refresh tokens |
|---|---|---|
| [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) | `redirect_uri` "must be a match to one of the URLs you provided" (was "an exact match" before 14 August 2026), with a link to the callback URL page. A mismatch gives `redirect_uri_mismatch`. | Expiring by default. `scope` is optional and takes only `offline_access`. A refresh token arrives whenever the access token expires. |
| [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens) | Not covered. | Expiration "is enabled unless you opt out". `offline_access` opts one sign-in in when the App has opted out. The refresh request and response are unchanged. |
| [About the user authorization callback URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url) | New section on wildcard matching: the rule, the example, the per-callback-URL switch, the warning, and the 3 August 2026 cut-off. | Not covered. |
| [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) | Step 9 covers the callback URL and up to 10 of them. Nothing on wildcard matching. Not edited by either change. | Step 10: deselect **Expire user authorization tokens** to opt out. Nothing on `offline_access`. Not edited by either change. |

Both the generating page and the refreshing page still carry the older note that "User access tokens that expire are currently an optional feature and are subject to change."

## Documented, and inferred

Documented by GitHub:

- Wildcard matching is a setting on each callback URL of a GitHub App. Off means an exact match. On means subdomains and deeper paths.
- Apps that had a single callback URL before 3 August 2026 have it on.
- A new GitHub App has token expiration on unless its owner opts out, and an App with expiration on receives a refresh token with each user access token.
- `offline_access` is optional, is the only value `scope` accepts for a GitHub App, and affects one sign-in.

Inferred here:

- That an App registered after 3 August 2026 starts with wildcard matching off on its one callback URL.
- That nothing the Console puts in its own authorise request can stand in for the registration setting.
- That sending `offline_access` is harmless when expiration is already on. The docs describe what it adds for an App with expiration off and say nothing of an App with it on.
- That being private and owned by a personal account changes none of this. The sources draw no such line, in either direction.

## Not verified

- **Nothing was tried against a live App.** No App was registered, no sign-in made, no `redirect_uri` variant sent, no token response read.
- **The default state of wildcard matching on a newly registered App,** and the label and place of the switch in the settings page. The docs say only "in your app's settings".
- **Whether the switch is there at all on a given day.** In the linked discussion a reader reported on 28 August 2026 that the option had gone. The announcement's author replied that it had been rolled back over an issue and, later that day, that it was re-enabled ([forum replies](https://github.com/orgs/community/discussions/204963)). Nothing in the docs or changelog records this.
- **The 3 August date.** The docs give 3 August 2026 as the cut-off, and the changelog entry is dated 14 August. Neither says how an App registered between the two was treated.
- **How the code exchange treats `redirect_uri` under wildcard matching.** The exchange's `redirect_uri` row says only "This must match one of the URLs you provided".
- **Whether `scope=offline_access` alters the authorise page,** or does anything at all when expiration is already on.
- **The refresh.** #517 already lists it as untried, and that stands.

## Sources

- GitHub changelog, 14 August 2026: <https://github.blog/changelog/2026-08-14-multiple-redirect-uris-and-token-refresh-for-oauth-apps/>
- GitHub changelog, 13 October 2026: <https://github.blog/changelog/2026-10-13-github-app-improvements-for-least-privilege-and-management/>
- About the user authorization callback URL: <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url>
- Generating a user access token for a GitHub App: <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app>
- Refreshing user access tokens: <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens>
- Registering a GitHub App: <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app>
- Best practices for creating a GitHub App: <https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app>
- Registering a GitHub App from a manifest: <https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest>
- Activating optional features for GitHub Apps: <https://docs.github.com/en/apps/maintaining-github-apps/activating-optional-features-for-github-apps>
- Docs source, the wildcard passage: <https://github.com/github/docs/blob/main/data/reusables/apps/redirect-uri-wildcard-matching.md>
- Docs source, the August change: <https://github.com/github/docs/commit/74d2d500a67997b55f366c2387dc0280104fd9bc>
- Docs source, the October change: <https://github.com/github/docs/commit/d1a3effbebe44686297f72d0c97a81278b569a0e>
- Announcement discussion for the August entry (forum, weaker than the above): <https://github.com/orgs/community/discussions/204963>
- Announcement discussion for the October entry (forum, weaker than the above): <https://github.com/orgs/community/discussions/210226>
