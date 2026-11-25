# Okou for Even G2

Speak to a dedicated Okou conversation from Even G2 glasses and read replies on the lens. The phone runs the client and the glasses provide the microphone, touch controls and display.

## Install the Beta

Use the Even Hub Beta package for all product validation on the glasses. Accept the tester invitation, then open **Me → Beta tester → Okou → Install** in the Even Realities app using the invited account. Open Okou from the glasses launcher. [Even Hub Beta testing](https://hub.evenrealities.com/docs/test/beta-testing)

The installed Beta requests a device code directly from Clerk. If this step fails, version 0.4.3 and later show the build, WebView origin and any available HTTP status on the phone. After approval, the phone opens the conversation through the production Okou API. If the WebView cannot reach this API, the phone displays its origin for diagnosing CORS. Product acceptance covers the installed Beta on a paired phone and glasses.

## Sign in and use the glasses

1. Select **Sign in with Okou** on the phone. Open the displayed authorization page in a browser, enter the device code, choose a workspace and return to the Even App.
2. The first sign-in creates a conversation titled **Even G2**. Opening the app again on the same installation restores that conversation. Each Okou account and workspace has its own binding.
3. The lens starts quiet. A steady dot in the upper right means a reply is unread. A pulsing dot means Okou is working. Tap to open the latest reply. When the latest message is yours, the reader shows **Thinking...** until an answer arrives.
4. Swipe to scroll within the displayed reply. Double-tap to go quiet, or leave the reader idle for 30 seconds. A long press opens **Cancel current task**, **Back to main menu** (the glasses launcher), and **Back to Okou** (the reader).
5. Tap from the reader to record. **Listening...** appears at the lower right. Tap to send or double-tap to discard. A long press offers the same two actions. At the one-minute limit the microphone closes and the recording waits for your decision. The public G2 SDK provides microphone audio, so Okou sends the recording without a live transcript.
6. Use **Sign out** on the phone to change account or workspace.

## Device protocol

The installed public client uses Clerk's device authorization grant at `https://clerk.okou.ai` and requests `openid profile offline_access user:org:read okou:chat:read okou:chat:send`. The access token stays in memory. The package encrypts the rotating refresh token with AES-GCM. Deriving the wrapping key requires both a random seed in Even's package storage and a random share in a first-party, host-only cookie. The cookie spans the loopback ports Even assigns on launch. Restoring the session requires both stores. Signing out clears the local grant and asks Clerk to revoke it. The pending device code is tab-local.

Even's package storage keeps a conversation binding per Okou account and workspace. The client reserves the thread ID before sending `POST /api/chat-threads` and reuses it after a lost response. An established binding is replaced only when its metadata returns 404 or 410. During the upgrade from 0.4.3 the client can import the old IndexedDB grant and binding if it opens on the old origin. If that origin is unavailable, one new sign-in and conversation may be needed. Development browsers without the Even bridge continue to use IndexedDB.

Voice capture produces a 16 kHz mono PCM16 WAV. The package prepares a private upload at `api.okou.ai`, PUTs the recording to the signed private R2 URL and completes the upload at the Okou API. The installed origin needs CORS access to the Bearer API and signed PUT. The client sends the resulting file ID as a version-1 voice part in the bound thread, preserving its current computer host and cloud browser settings. The event IDs, file ID and target settings are saved before submission. If the result is uncertain, the client reconciles the original input or its promoted row from history. The phone's explicit retry reuses that exact request.

The reader follows a signed NDJSON snapshot and paired event/sequence cursors. It keeps the 200 most recent presentation and run-lifecycle rows in memory. Ably subscriptions on `user-org:<user>:<org>` wake only the bound thread for message/detail changes. Attachment, app resume, and reconnect trigger catch-up. While realtime is unavailable the foreground app also checks every 30 seconds.

## Development

The packaged client uses the Clerk public client ID in `src/config.ts`. The legacy Worker's `OAUTH_CLIENT_ID` is configured separately in `wrangler.jsonc`. For a local Worker override, copy `.dev.vars.example` to `.dev.vars`.

```sh
npm ci
npm run typecheck
npm test
npm run dev
```

The development command builds the frontend and serves it with the Worker at `http://localhost:5173` for local debugging.

## Release a Beta

For each new Beta, increment the version in `app.json`, build the client and pack it with the Even Hub CLI.

```sh
npm run build
npm exec --yes --package=@evenrealities/evenhub-cli@0.2.0 -- evenhub pack app.json dist -o okou.ehpk --sdk-ver 0.0.15
```

Upload `okou.ehpk` to the Okou project in Even Hub and publish that version to the Beta channel. For the session check, sign in, note the conversation ID, fully close the Even app and reopen the Beta on a different loopback port. Confirm it opens the same conversation and that an explicit sign-out persists after another reopen. For the voice check, send a recording and verify the reply on the lens.

## G2 Worker

`npm run deploy` publishes the Worker on `g2.okou.ai`. Its `/api/` routes handle device auth and private audio uploads. The retired QR URL and client asset URLs return HTTP 410 with Beta installation instructions.
