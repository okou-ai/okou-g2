# Okou for Even G2

Speak to a dedicated Okou conversation from Even G2 glasses and read replies on the lens. The phone runs the client and the glasses provide the microphone, touch controls and display.

## Install the Beta

Use the Even Hub Beta package for all product validation on the glasses. Accept the tester invitation, then open **Me → Beta tester → Okou → Install** in the Even Realities app using the invited account. Open Okou from the glasses launcher. [Even Hub Beta testing](https://hub.evenrealities.com/docs/test/beta-testing)

For a development build you upload manually, open **Even Hub → Me → Apps → Private builds** on the phone and launch it from there. Private builds support brief background use. Releases from `main` appear under **Beta tester** after promotion. Use that installation for the five-minute locked-phone check. [Even Hub developer installation](https://hub.evenrealities.com/docs/test/private-testing)

The installed Beta requests a device code directly from Clerk. If this step fails, version 0.4.3 and later show the build, WebView origin and any available HTTP status on the phone. After approval, version 0.4.5 opens the conversation through the public Okou MCP endpoint. If the WebView cannot reach this endpoint, the phone displays its origin for diagnosing CORS.

## Sign in and use the glasses

1. On the phone, tap the sign-in link to select and copy it, or tap **Copy link**. Paste the complete link into your browser, sign in and choose a workspace. The Even App checks for approval after copying and when you return. Once signed in, **How to use** shows the reader, recorder and sending screens. Tap a step or swipe the screenshot to change it. Tap the image to see it at lens resolution.
2. While you sign in on the phone, the glasses show the Okou planet with a star circling every 7.4 seconds. The phone hint stays in the lower right throughout sign-in. Once signed in, the lens shows the latest reply, or the planet in an empty reader. The first sign-in creates a conversation titled **Even G2**. Opening the app again on the same installation restores that conversation. Each Okou account and workspace has its own binding.
3. The lens opens on the latest assistant reply. After 15 seconds without a gesture in the reader, the lens goes quiet. With no task or unread reply, it stays blank. While a task runs, three small dots hop from left to right in the upper-left corner every two seconds. An unread reply takes priority and shows a steady large dot followed by **OKOU**. Tap, double-tap, hold, or swipe to wake the reader. The wake gesture returns you to your place in the reply.
4. Swipe through the reply. Each page fits up to eight lines. The center of the footer shows **∨** for the next page, **∧** for the previous page, or **∧ ∨** for both. Double-tap in the reader for the system exit prompt. Hold to open the menu with **Cancel current task**, **Back to main menu** (the glasses launcher), and **Back to Okou** (the reader). Hold again to go back.
5. Tap from the reader to record. **● Listening MM:SS** appears in the upper-right header. Tap to send or hold to discard. You can keep reading and turning pages while recording or sending. During **● Sending** the bottom corners are empty until an action is available again. Capture continues across segment boundaries until you send or discard. The active recording lives in memory until you send, discard, or exit. The public G2 SDK provides microphone audio, so Okou sends the recording without a live transcript.
6. Use **Sign out** on the phone to change account or workspace.

## Device protocol

The installed public client uses Clerk's device authorization grant at `https://clerk.okou.ai`. It requests the resource `https://api.okou.ai/mcp` and the scopes `openid profile offline_access user:org:read okou:chat:read okou:chat:send okou:run:cancel`. Clerk device grants can omit `aud`. An explicit audience must include the MCP URL. Refresh inherits the original grant. The API verifies the signed token, workspace membership and tool permissions on each request. If the grant lacks cancellation permission, selecting **Cancel current task** prompts the user to authorize again on the phone.

The access token stays in memory. The client stores its refresh grant and one conversation binding per account and workspace in Even’s native, package-scoped key-value store. A 0.4.17 installation can import its existing native grant once using its previous cookie share. Signing out clears the grant and requests revocation at Clerk. A browser preview without the Even bridge uses memory for the current page.

All Okou API operations use authenticated JSON-RPC `tools/call` requests to `https://api.okou.ai/mcp`. The client reserves a thread ID before calling `create_chat_thread` and reuses it after a lost response. It replaces that binding only when `get_chat_messages` confirms the thread is missing. Each launch loads the bound conversation from its current server snapshot and subsequent events. The reading position, device-code challenge and pending voice send live only for that launch.

The upper-right lens status shows `● Listening MM:SS` from captured audio samples and grows to three minute digits after 99:59.

Voice capture buffers 16 kHz mono PCM16 as 15-second Blob segments in memory. Each recording gets a client event ID at microphone open. On send, the client groups the segments into WAV files of at most 25 MiB, reuses completed uploads on an explicit retry, and submits the ordered voice parts as one input. It calls `prepare_voice_upload`, PUTs the bytes to the signed private R2 URL, then calls `complete_voice_upload`. The signed PUT uses the returned headers and omits the Okou bearer token. The device adds one `additional_info` part describing the lens. An explicit retry within the same launch reuses the original event and file IDs. Server history confirms the pending input by its ID or the promotion’s reference to it. Reopening reads that history without replaying a send.

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

## Release a Beta

Every push to `main` runs the **Even Hub Beta** GitHub Actions workflow. It adds the workflow run number to the patch version in `app.json` in the build checkout. With the baseline `0.4.27`, run 1 ships `0.4.28`. Both the app and its package read that same version. Rerunning a release keeps its version.

After typechecking and tests pass, the workflow builds one `.ehpk` and saves it as a run artifact. It uploads that file to Even Hub, downloads the version to compare its bytes, promotes it to Beta and reads back the channel. To retry an interrupted publication, use **Re-run failed jobs**. The publish job reuses the original artifact, checks any existing upload and keeps a newer Beta in place.

Set up the `EVENHUB_CREDENTIALS` repository Actions secret once using the Even Hub account that owns `ai.okou.g2`:

```sh
npx --yes --package=@evenrealities/evenhub-cli@0.2.0 evenhub login
gh secret set EVENHUB_CREDENTIALS --repo okou-ai/okou-g2 < "${XDG_CONFIG_HOME:-$HOME/.config}/evenhub/credentials.yaml"
```

Repeat the login and replace the secret when its refresh token expires. [Even Hub CI authentication](https://hub.evenrealities.com/docs/cli/auth)

For the session check, sign in, note the conversation ID, fully close the Even app and reopen the Beta on a different loopback port. Confirm it opens the same conversation and that an explicit sign-out persists after another reopen. Lock the phone for at least five minutes, then turn a page on the lens. For the voice check, send a recording and verify the reply.

## G2 Worker

`npm run deploy` publishes the Worker on `g2.okou.ai`. Its `/api/` routes handle device auth and private audio uploads. The retired QR URL and client asset URLs return HTTP 410 with Beta installation instructions.
