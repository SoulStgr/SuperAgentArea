# Third-party notices

## dsh-im — protocol details adapted

The DingTalk, QQ and WeChat Sources of this repository adapt protocol details from **dsh-im**, Copyright (c) 2026 xmanrui,
upstream version **5.10.0** (`https://github.com/xmanrui/dsh-im`), under the MIT License reprinted below. No part of
dsh-im is imported as a runtime dependency: the adapted code lives in `src/sources/im/dingtalk-transport.ts`,
`src/sources/im/qq-transport.ts`, `src/sources/im/weixin-transport.ts` and `src/sources/im/weixin-login.ts`, and each
speaks the same wire protocol through this repository's own Source adapter. Only the connection and protocol layer was
adapted; the bridge, controller, command, approval, workspace and deferred-delivery logic of dsh-im was neither copied nor
ported.

### DingTalk

| Upstream file (dsh-im 5.10.0) | Adapted into (this repository) | What was adapted |
| --- | --- | --- |
| `src/channels/dingtalk/dingtalk-runtime.mjs` | `src/sources/im/dingtalk-transport.ts` (`DingtalkConnection`) | Creating the `dingtalk-stream` `DWClient` with the app credentials, the bot-message topic `/v1.0/im/bot/messages/get`, acknowledging a callback before processing it, the connection monitor, and the start/stop ordering. This repository replaces dsh-im's embedded socket reconnect with its Source loop's 5 s–60 s backoff and its own health reporting |
| `src/channels/dingtalk/dingtalk-api.mjs` | `src/sources/im/dingtalk-transport.ts` (`dingtalkAccessToken`, `sendDingtalkWebhook`, `sendDingtalkRobot`, `normalizeDingtalkCallback`, `normalizeDingtalkSessionWebhook`, `splitDingtalkText`, `DingtalkApiError`) | The OAuth2 access-token request and cache, the `sessionWebhook` text reply with DingTalk's native `at` field, the robot `groupMessages/send` and `oToMessages/batchSend` text payloads, the callback field names (`msgId`, `senderStaffId`, `senderNick`, `conversationId`, `conversationType`, `isInAtList`, `sessionWebhook`, `sessionWebhookExpiredTime`, `robotCode`, `chatbotUserId`), trusted-reply-URL checks, text splitting and failure classification |
| `src/channels/dingtalk/dingtalk-menu.mjs` | — (read only) | Read for the callback envelope shape and card topic; AI Cards, menus and streaming updates are deliberately **not** part of this adaptation |

Not adapted and not copied: `dingtalk-bridge.mjs`, `dingtalk-controller.mjs`, `dingtalk-card-stream.mjs`, `config-store.mjs`,
`state-store.mjs`, and every file under `src/channels/shared/`. Session binding, commands, approvals, workspaces, deferred
delivery and artifact delivery stay this repository's own Ticket, Outbox and Source mechanisms.

### QQ

| Upstream file (dsh-im 5.10.0) | Adapted into (this repository) | What was adapted |
| --- | --- | --- |
| `src/channels/qq/qq-runtime.mjs` | `src/sources/im/qq-transport.ts` (`QqConnection`, `qqBotFactory`, `normalizeQqInbound`) | Creating the SDK's `QQBot` with the bot credentials over the WebSocket gateway (`transport: 'websocket'`, synchronous token prefetch), the `ready`/`resumed`/`error`/`message` handlers, the bounded wait for READY and the connection/start/stop ordering. This repository replaces dsh-im's embedded reconnect reporting with its Source loop's 5 s–60 s backoff, three-consecutive-error threshold and its own health reporting |
| `src/channels/qq/qq-controller.mjs` | `src/sources/im/qq-transport.ts` (`QqConnection`, `sendQqReply`) | The send path over the connected bot: `msg_id` and `msg_seq` on a passive reply, `markdownSupport: false` for the bot client, and the credential-free failure classification. The QR sign-in, credential store, workspace state and rename/delete flows are deliberately **not** part of this adaptation |
| `src/channels/qq/markdown-reply.mjs` | `src/sources/im/qq-transport.ts` (`sendQqPiece`, `sendQqReply`, `QQ_PASSIVE_REPLY_LIMIT`, `QQ_MARKDOWN_REJECTION_CODES`) | Markdown (`msg_type=2`) first and plain text (`msg_type=0`) on a definite markdown rejection, the passive reply budget of 4 direct / 5 group messages per inbound `msg_id`, and the rule that an uncertain delivery is never retried as a second transport |
| `src/channels/qq/qq-mention.mjs` | `src/sources/im/qq-transport.ts` (`addressedToBot`, `withoutSelfMention`, `normalizeQqInbound`, `qqMention`) | The group @-message decision from the raw event type, an `is_you` mention or an inline `<@id>` marker, learning the bot's own ids from READY, and stripping only the bot's own mention markers from the content |
| `src/channels/shared/markdown-chunks.mjs` | `src/sources/im/qq-transport.ts` (`splitQqText`) | Line-break-aware text splitting for a reply longer than one QQ message |

Not adapted and not copied: `qq-bridge.mjs`, `qq-menu.mjs`, `config-store.mjs`, `state-store.mjs`, `qr-auth.mjs`,
`state-error.mjs`, `harness-client.mjs`, and every file under `src/channels/shared/`. Session binding, commands, approvals,
workspaces, deferred delivery and artifact delivery stay this repository's own Ticket, Outbox and Source mechanisms; the
QR-code sign-in and AppSecret provisioning of dsh-im are replaced by the credentials a person enters in this installation's
settings.

### WeChat (iLink)

| Upstream file (dsh-im 5.10.0) | Adapted into (this repository) | What was adapted |
| --- | --- | --- |
| `src/channels/weixin/weixin-api.mjs` | `src/sources/im/weixin-transport.ts` (`beginWeixinLogin`, `pollWeixinLogin`, `getWeixinUpdates`, `sendWeixinText`, `normalizeWeixinInbound`, `splitWeixinText`) and `src/sources/im/weixin-login.ts` (`renderWeixinQrImage`) | The iLink base URL and protocol version 2.4.6, the `iLink-App-Id`/`iLink-App-ClientVersion`/`X-WECHAT-UIN` headers, the bot-token bearer and `AuthorizationType`, the `base_info` payload, the QR handshake (`ilink/bot/get_bot_qrcode?bot_type=3` with `local_token_list`, `ilink/bot/get_qrcode_status`) and its statuses, the `ilink/bot/getupdates` long poll with its `get_updates_buf` cursor (a timeout means no messages), the `ilink/bot/sendmessage` text item with `context_token` and `run_id`, the `message_type` 2 self-message skip, text and voice-transcript extraction, the 1,800-character line-break-aware splitter, trusted-WeChat-URL checks, the `ret`/`errcode` rejection codes and the `-14` stale token, and the failure classification (`network`, `timeout`, `auth`, `rate-limit`, `rejected`, `invalid-response`). The image/file encryption, CDN upload, reply-quote snapshot, typing indicator and proactive-delivery paths are deliberately **not** part of this adaptation |
| `src/channels/weixin/weixin-runtime.mjs` | `src/sources/im/weixin-login.ts` (`WeixinLoginManager`), `src/sources/wechat.ts` (`watchWechat`, `runWechatInstance`) | The status monitor over `getupdates` (an ordered batch, a cursor committed after handling, three consecutive failures then a backoff), the single attempt that receives one confirmed credential, and the stop/start ordering. This repository replaces dsh-im's Harness bridge and reply bookkeeping with its own Ticket, Outbox and Channel mechanisms |
| `src/channels/weixin/weixin-controller.mjs` | `src/sources/im/weixin-login.ts` (`WeixinLoginManager`), `src/app/http.ts` (`POST sources/:id/wechat/login`, `GET sources/:id/wechat/login/:loginId`, `GET sources/:id/wechat/status`) | The QR attempt lifecycle: a five-minute attempt, only the newest attempt of an account kept, the `confirmed` answer's `bot_token`/`ilink_bot_id`/`ilink_user_id`, the expired state allowing a new attempt, and the account metadata kept beside the credential. The config store, credential store, per-account runtime supervisor and the panel RPC layer are **not** adapted: the credential is written to this repository's own KV record and the token never leaves the host |

Not adapted and not copied: `weixin-bridge.mjs`, `weixin-controller.mjs`'s config/credential stores and supervisor,
`config-store.mjs`, `state-store.mjs`, `connection-error.mjs`, `harness-client.mjs`, and every file under
`src/channels/shared/`. Session binding, commands, approvals, workspaces, deferred delivery and artifact delivery stay this
repository's own Ticket, Outbox and Source mechanisms. Group chats, media messages and proactive delivery are out of scope
for this adaptation.

### MIT License (dsh-im)

Copyright (c) 2026 xmanrui

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## qrcode — npm dependency

`qrcode` 1.5.4 (MIT License, Copyright the qrcode contributors) is installed from npm as a normal dependency and is not
copied into this repository. Its own package carries its license. The WeChat Source renders a QR code as a PNG data URL
with it when iLink returns QR content that is not already an image URL; the dependency is loaded lazily and is not part of
the panel bundle.

## dingtalk-stream — npm dependency

`dingtalk-stream` 2.1.4 (the official DingTalk Stream Mode Node.js SDK, MIT License, Copyright the DingTalk open-platform
team) is installed from npm as a normal dependency and is not copied into this repository. Its own package carries its
license; the DingTalk Source builds on its client and topic constants.

## @tencent-connect/qqbot-nodejs — npm dependency

`@tencent-connect/qqbot-nodejs` 1.0.4 (the QQ Open Platform Node.js SDK, MIT License, Copyright Tencent) is installed from
npm as a normal dependency and is not copied into this repository. Its own package carries its license; the QQ Source
builds on its `QQBot` WebSocket gateway client, its passive reply send path and its `ApiError` failure shape (read
structurally, so the transport module does not import the SDK; only the production bot factory loads it, lazily).

`@tencent-connect/qqbot-connector` 1.2.0 is deliberately **not** a dependency: it only provides the QR-code sign-in that
provisions an AppSecret, while this repository takes the AppID and AppSecret from its own settings. Its upstream package
is also marked `UNLICENSED`, so it is not redistributed here.

## Upgrading

When dsh-im is upgraded upstream, diff its `src/channels/dingtalk/`, `src/channels/qq/` and `src/channels/weixin/` against
the tables above and merge protocol changes by hand (for QQ also the shared `markdown-chunks.mjs`). This repository pins
the adapted version in this file (5.10.0) and never adds `@xmanrui/dsh-im` as a dependency.
