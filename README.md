# Okou for Even G2

Speak to a dedicated Okou conversation from Even G2 glasses and read replies on the lens. Open the hosted app in the Even App WebView on a phone paired with G2. The phone runs the client and the glasses provide the microphone, touch controls and display.

## Sign in and use the glasses

1. Select **Sign in with Okou** on the phone. Open the displayed authorization page in a browser, enter the device code, choose a workspace and return to the Even App.
2. The first sign-in creates a conversation titled **Even G2**. Opening the app again on the same installation restores that conversation. Each Okou account and workspace has its own binding.
3. The lens starts quiet. A steady dot in the upper right means a reply is unread. A pulsing dot means Okou is working. Tap to open the latest reply. When the latest message is yours, the reader shows **Thinking...** until an answer arrives.
4. Swipe to scroll within the displayed reply. Double-tap to go quiet, or leave the reader idle for 30 seconds. A long press opens **Cancel current task**, **Back to main menu** (the glasses launcher), and **Back to Okou** (the reader).
5. Tap from the reader to record. **Listening...** appears at the lower right. Tap to send or double-tap to discard. A long press offers the same two actions. At the one-minute limit the microphone closes and the recording waits for your decision. The public G2 SDK provides microphone audio, so Okou sends the recording without a live transcript.
6. Use **Sign out** on the phone to change account or workspace.

## Device protocol

The OAuth client uses Clerk's device authorization grant and requests `openid profile offline_access user:org:read okou:chat:read okou:chat:send`. The G2 Worker exchanges grants with the production issuer at `https://clerk.okou.ai`. The short-lived access token stays in memory. The rotating refresh token is scoped to the host in a Secure, HttpOnly, SameSite=Strict cookie. Grant operations accept same-origin POSTs. The pending code is tab-local and survives a reload while approval is open.

IndexedDB reserves a UUID before sending `POST /api/chat-threads`. A lost creation response reuses the reservation. An established binding is replaced only when its metadata returns 404 or 410. Clearing the WebView's site data removes its local binding.

Voice capture produces a 16 kHz mono PCM16 WAV. The same-origin Worker prepares a private upload at the Okou API, PUTs the recording to the returned R2 URL with its signed headers, and completes the upload. The private bucket requires a server-side PUT from this origin. The client sends the resulting file ID as a version-1 voice part in the bound thread, preserving its current computer host and cloud browser settings. The event IDs, file ID and target settings are saved before submission. If the result is uncertain, the client reconciles the original input or its promoted row from history. The phone's explicit retry reuses that exact request.

The reader follows a signed NDJSON snapshot and paired event/sequence cursors. It keeps the 200 most recent presentation and run-lifecycle rows in memory. Ably subscriptions on `user-org:<user>:<org>` wake only the bound thread for message/detail changes. Attachment, app resume, and reconnect trigger catch-up. While realtime is unavailable the foreground app also checks every 30 seconds.

## Development

Use the public client ID of a Clerk application with the device grant, refresh tokens, workspace selection and Okou chat scopes. Set the Worker's `OAUTH_CLIENT_ID` in `wrangler.jsonc` for deployment. For a local override, copy `.dev.vars.example` to `.dev.vars`. The production client requires no client secret.

```sh
npm ci
npm run typecheck
npm test
npm run dev
```

The development command builds the SPA and serves it with the Worker at `http://localhost:5173`. Use an HTTPS deployment when loading from a phone. Both the SPA and its Worker routes must be served from the same origin. Okou API and signed history reads must allow that origin.

## Deployment

The Worker and Vite assets are deployed together on `g2.okou.ai`.

```sh
npm run deploy
npx @evenrealities/evenhub-cli qr --url https://g2.okou.ai
```

Scan the URL QR from the Even App. This hosted flow keeps OAuth cookies and microphone uploads on the G2 origin.
