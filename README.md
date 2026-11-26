# Okou for Even G2

Speak to a dedicated Okou conversation from Even G2 glasses and read replies on the lens. The phone runs the client and the glasses provide the microphone, touch controls and display.

## Install the Beta

Use the Even Hub Beta package for all product validation on the glasses. Accept the tester invitation, then open **Me → Beta tester → Okou → Install** in the Even Realities app using the invited account. Open Okou from the glasses launcher. [Even Hub Beta testing](https://hub.evenrealities.com/docs/test/beta-testing)

To install your own build with the developer account, open **Even Hub → Me → Apps → Private builds** on the phone and launch it from there. Private builds support brief background use. Use the Beta tester installation for the five-minute locked-phone check. The line under **Okou for Even G2** shows the running version before sign-in. [Even Hub developer installation](https://hub.evenrealities.com/docs/test/private-testing)

The installed Beta requests a device code directly from Clerk. If this step fails, version 0.4.3 and later show the build, WebView origin and any available HTTP status on the phone. After approval, version 0.4.5 opens the conversation through the public Okou MCP endpoint. If the WebView cannot reach this endpoint, the phone displays its origin for diagnosing CORS.

## Sign in and use the glasses

1. Select **Sign in with Okou** on the phone. Open the displayed authorization page in a browser, enter the device code, choose a workspace and return to the Even App. Returning checks authorization. If needed, tap **Check authorization**.
2. The first sign-in creates a conversation titled **Even G2**. Opening the app again on the same installation restores that conversation. Each Okou account and workspace has its own binding.
3. The lens starts quiet. A steady dot in the upper right means a reply is unread. A pulsing dot means Okou is working. Tap to open the latest assistant reply. Locking the phone keeps your place on the lens. During **● Sending** you can turn pages using the center arrows. Both bottom corners are empty until an action is available again.
4. Swipe through the reply. Each page fits up to eight lines. The center of the footer shows **∨** for the next page, **∧** for the previous page, or **∧ ∨** for both. A single-page reply has no arrows. Double-tap in the reader to go quiet. A long press there opens **Cancel current task**, **Back to main menu** (the glasses launcher), and **Back to Okou** (the reader).
5. Tap from the reader to record. **● Listening MM:SS** appears in the upper-right header, with the primary gesture at the bottom left and secondary gestures at the bottom right. Swipe to continue reading while recording or sending. Tap to send the recording or double-tap to discard it. Capture continues across segment boundaries until you send or discard. If local storage fills, the microphone stops and the captured audio is available to send. The public G2 SDK provides microphone audio, so Okou sends the recording without a live transcript.
6. Use **Sign out** on the phone to change account or workspace.

## Device protocol

The installed public client uses Clerk's device authorization grant at `https://clerk.okou.ai`. It requests the resource `https://api.okou.ai/mcp` and the scopes `openid profile offline_access user:org:read okou:chat:read okou:chat:send okou:run:cancel`. Clerk device grants can omit `aud`. An explicit audience must include the MCP URL. Refresh inherits the original grant. The API verifies the signed token, workspace membership and tool permissions on each request. If the grant lacks cancellation permission, selecting **Cancel current task** prompts the user to authorize again on the phone.

The access token stays in memory. The package encrypts the rotating refresh token with AES-GCM. Deriving the wrapping key requires both a random seed in Even's package storage and a random share in a first-party, host-only cookie. The cookie spans the loopback ports Even assigns on launch. Signing out clears the local grant and asks Clerk to revoke it. The pending device code is tab-local.

All Okou API operations use authenticated JSON-RPC `tools/call` requests to `https://api.okou.ai/mcp`. Even's package storage keeps a conversation binding per account and workspace. The client reserves a thread ID before calling `create_chat_thread` and reuses it after a lost response. It replaces the binding only when `get_chat_messages` confirms the thread is missing. During the upgrade from 0.4.3 the client can import the old IndexedDB grant and binding if it opens on the old origin. If that origin is unavailable, one new sign-in and conversation may be needed. Development browsers without the Even bridge continue to use IndexedDB.

The upper-right lens status shows `● Listening MM:SS` from captured audio samples and grows to three minute digits after 99:59.

Voice capture stages 16 kHz mono PCM16 locally in 15-second segments encrypted with an in-memory key. On send, it reads at most one WAV (up to 25 MiB) at a time, reuses completed uploads on retry, and submits the ordered voice parts together as one input. Discarding before send clears the local draft. The client calls `prepare_voice_upload`, PUTs the bytes to the signed private R2 URL, and calls `complete_voice_upload`. The signed PUT uses the returned headers and omits the Okou bearer token. The client saves the ordered file IDs, device context and a stable client event ID before calling `send_chat_message`. One `additional_info` part after the voice parts describes the lens and its text layout. The server applies the thread's current computer host and browser settings. If delivery is uncertain, the client checks the original input or its promoted row in history. An explicit retry reuses the saved IDs.

The reader calls `get_chat_messages` and follows its signed NDJSON snapshot and paired event/sequence cursors. It retains the latest assistant text and the event metadata used to resolve task state, replacements and recalls. `get_chat_realtime_token` authorizes an Ably subscription on `user-org:<user>:<org>` for updates to the bound thread. Attachment, app resume, and reconnect trigger catch-up. **Cancel current task** calls `cancel_run` for an active run or `revoke_queued_message` for a queued input.

## Development

The packaged client uses the Clerk public client ID in `src/config.ts`. The legacy Worker's `OAUTH_CLIENT_ID` is configured separately in `wrangler.jsonc`. For a local Worker override, copy `.dev.vars.example` to `.dev.vars`.

```sh
npm ci
npm run typecheck
npm test
npm run dev
```

The development command builds the frontend and serves it with the Worker at `http://localhost:5173` for local debugging.

## Release the developer build and Beta

Commit G2 changes directly to `main` and push them. Every release updates both Even Hub install paths from that commit. Select two unused numeric versions with the higher one in `app.json` for Beta. The portal requires unique versions and moves a promoted build out of the Private builds list.

In a clean checkout of the pushed revision, install the locked dependencies and verify it. Pass the developer version to the release command. For example, with Beta `0.4.17` in `app.json`, run:

```sh
npm ci
npm run typecheck
npm test
npm run pack:release -- 0.4.16
```

The command checks the revision against remote `main`, builds the client once, and packs the same `dist` files twice. Only the outer manifest version differs. Both phone screens show the client version from `app.json`.

Upload both files from `build/` to the Okou project, leave the developer version in Private builds, and promote the Beta version. Refresh the portal and check both install lists. Compare each portal download with its local package and check the intended tester's invitation status.

For the session check, sign in, note the conversation ID, fully close the Even app and reopen the Beta on a different loopback port. Confirm it opens the same conversation and that an explicit sign-out persists after another reopen. Lock the phone for at least five minutes, then turn a page on the lens. For the voice check, send a recording and verify the reply.

## G2 Worker

`npm run deploy` publishes the Worker on `g2.okou.ai`. Its `/api/` routes handle device auth and private audio uploads. The retired QR URL and client asset URLs return HTTP 410 with Beta installation instructions.
