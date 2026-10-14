# cat_facts_bot

meow

A small Cloudflare Worker that responds to Google Chat messages with a random
fact from [catfact.ninja](https://catfact.ninja/fact).

Google Chat sends an interaction event to the Worker using HTTP POST. The Worker
fetches the fact and returns a card with a **Meow** header, italic fact text,
and a blue **Get Another Fact** button. Refreshing replaces the fact in the existing
message. In optional plain-text mode, it returns a message such as:

```json
{ "text": "🐱 *Meow*\nCats have whiskers." }
```

Browser JavaScript isn't needed. The Worker runs the JavaScript on the server.
The Express-style `exports.googleChatBot(req, res)` example must be adapted to
Workers' `fetch(request, env)` handler. Native `fetch` replaces Axios.

## Cloudflare build settings

Connect this repository to the existing **cat-facts-bot** Worker. Use:

| Setting | Value |
| --- | --- |
| Root directory | Repository root (`/`) |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Production branch | The branch you push this code to |

`npm run build` is now defined in `package.json`. It runs Wrangler with
`--dry-run` to validate and bundle without publishing. The deploy command then
publishes the source specified in `wrangler.jsonc`. Commit `package-lock.json`
along with the source so Cloudflare installs consistent dependencies.

Cloudflare's separate build command is optional: you can also leave it blank and
keep `npx wrangler deploy`, which bundles automatically. Do not add the build
script to Wrangler's `build.command`; this script itself invokes Wrangler.

See [Cloudflare build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
and [Wrangler bundling](https://developers.cloudflare.com/workers/wrangler/custom-builds/).

The configuration already uses your Worker name and this endpoint:

```text
https://cat-facts-bot.algo-alert-cramer.workers.dev/
```

Deployment uses your Cloudflare account's Workers subdomain. Confirm that it is
`algo-alert-cramer`; the Worker name alone doesn't select an account/subdomain.

## Google Cloud Console settings

1. Select your Google Cloud project, enable **Google Chat API**, and open its
   **Configuration** tab.
2. Set the app name to **Cat Facts Bot**, add a description, and provide an
   HTTPS avatar URL pointing directly to a square PNG/JPEG image.
3. Enable **Interactive features**. Clear **Build this Chat app as a Google
   Workspace add-on**, confirming **Disable** if prompted. This code uses
   Chat interaction events (`type: "MESSAGE"`) and direct message responses.
4. Enable **Join spaces and group conversations**. Leave **Support App Home** off.
5. Under **Connection settings**, select **HTTP endpoint URL** and enter exactly
   `https://cat-facts-bot.algo-alert-cramer.workers.dev/`.
6. Set **Authentication Audience** to **HTTP endpoint URL**, rather than
   **Project Number**. The URL must match `GOOGLE_CHAT_AUDIENCE` in
   `wrangler.jsonc`, including the trailing slash.
7. Under **Visibility**, add your company email or a Google Group containing
   your intended coworkers. Save.
8. In Google Chat, find/add the app and send it a direct message. In a shared
   space, add the app and **@mention it** to request a fact.

See Google's [configuration guide](https://developers.google.com/workspace/chat/configure-chat-api#chat-apps-that-arent-add-ons-configure-the-google-chat-api).
Workspace administrator app policies can affect availability. Company-wide
distribution can use a private Marketplace listing; start with the visibility
list to test with coworkers.

## Request verification

The public URL accepts Chat POST requests only after verifying Google's signed
ID token: signature, issuer, expiry, audience, and the verified service-account
email `chat@system.gserviceaccount.com`. Google's public signing keys are fetched
and cached by `jose`. You don't need a Google service-account private key for
these synchronous replies. See [Google's request verification guide](https://developers.google.com/workspace/chat/verify-requests-from-chat#verify-app-url).

Visibility controls which users can access the app in Chat. The Worker verifies
the calling Chat service; it doesn't separately enforce a company email domain.
No Chat event bodies or bearer tokens are logged or stored by this code.

## Local development and validation

Use Node.js 22 or newer:

```sh
npm ci
npm test
npm run build
npm run dev
```

Visit `http://localhost:8787/` to check the health response. An unsigned POST
returns HTTP 401 intentionally. Tests use locally signed tokens and mocked API
responses, including incorrect tokens and upstream failures.

For a manual deployment instead of the connected repository build:

```sh
npx wrangler login
npm run deploy
```

After deployment, opening the production URL in a browser returns a small health
JSON response. It doesn't fetch a fact; test that by messaging the app in Chat.
The Worker fetches facts with an eight-second timeout and returns a friendly
Chat message with HTTP 200 if the upstream API fails.

## Card appearance and refresh

Cards are enabled by default (`RESPONSE_FORMAT: "card"` in `wrangler.jsonc`).
External fact text is escaped for card HTML. `fallbackText` provides notification
text without repeating the fact above the card. There is no Read Source button.
The header has no photo or subtitle. The refresh button uses blue (`#1A73E8`).
Google Chat controls card and section backgrounds and the font family, including
their appearance in light and dark themes. Native cards support italic text,
but do not expose settings for custom section backgrounds or Comic Sans. See
[Google's card formatting guide](https://developers.google.com/workspace/chat/format-messages#format-text-in-cards)
and [card schema](https://developers.google.com/workspace/chat/api/reference/rest/v1/cards).

**Get Another Fact** sends a `CARD_CLICKED` event to the same Worker endpoint.
The Worker handles `fetchNewFact`, fetches a fact, and returns
`actionResponse.type: "UPDATE_MESSAGE"` with the same `catFactCard` ID. Errors
also display a card with the button so users can retry. No additional Google
Console endpoint or OAuth scopes are needed for the refresh action.

For plain-text responses without a refresh button, set `RESPONSE_FORMAT` to
`"text"` and redeploy. Buttons on previously sent cards still work.

The app responds on demand. It doesn't send scheduled daily facts.

## Troubleshooting

- **Missing build script / missing entry point:** deploy this repository with
  `package.json`, `src/index.js`, and `wrangler.jsonc` at the configured root.
- **401 on Google Chat requests:** select HTTP endpoint URL authentication and
  check that the endpoint exactly matches `GOOGLE_CHAT_AUDIENCE`.
- **400 mentioning a missing type:** ensure the Workspace add-on option is off.
- **App not visible:** check the Visibility list and your Workspace app policy.
- **No response in a space:** @mention the app; ordinary messages aren't sent
  to it. Check Worker logs using `npx wrangler tail` for fact-fetch failures.
