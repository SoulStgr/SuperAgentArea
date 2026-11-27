# Third-party notices

## dsh-im — protocol details adapted

The DingTalk, QQ and WeChat Sources of this repository adapt protocol details from **dsh-im**, Copyright (c) 2026 xmanrui,
upstream version **5.10.0** (`https://github.com/xmanrui/dsh-im`), under the MIT License reprinted below. No part of
dsh-im is imported as a runtime dependency: the adapted code lives in `src/sources/im/dingtalk-transport.ts`,
`src/sources/im/dingtalk-device-auth.ts`, `src/sources/im/dingtalk-login.ts`, `src/sources/im/qq-transport.ts`,
`src/sources/im/weixin-transport.ts` and `src/sources/im/weixin-login.ts`, and each speaks the same wire protocol through
this repository's own Source adapter. Only the connection, protocol and sign-in layer was adapted; the bridge, controller,
command, approval, workspace and deferred-delivery logic of dsh-im was neither copied nor ported.

### DingTalk

| Upstream file (dsh-im 5.10.0) | Adapted into (this repository) | What was adapted |
| --- | --- | --- |
| `src/channels/dingtalk/dingtalk-runtime.mjs` | `src/sources/im/dingtalk-transport.ts` (`DingtalkConnection`) | Creating the `dingtalk-stream` `DWClient` with the app credentials, the bot-message topic `/v1.0/im/bot/messages/get`, acknowledging a callback before processing it, the connection monitor, and the start/stop ordering. This repository replaces dsh-im's embedded socket reconnect with its Source loop's 5 s–60 s backoff and its own health reporting |
| `src/channels/dingtalk/dingtalk-api.mjs` | `src/sources/im/dingtalk-transport.ts` (`dingtalkAccessToken`, `sendDingtalkWebhook`, `sendDingtalkRobot`, `sendDingtalkAttachment`, `uploadDingtalkMedia`, `dingtalkMediaMessage`, `downloadDingtalkAttachment`, `normalizeDingtalkCallback`, `normalizeDingtalkSessionWebhook`, `splitDingtalkText`, `DingtalkApiError`) | The OAuth2 access-token request and cache, the `sessionWebhook` text reply with DingTalk's native `at` field, the robot `groupMessages/send` and `oToMessages/batchSend` text payloads, the media-upload-plus-send path for a reply's files (`POST https://oapi.dingtalk.com/media/upload` with the access token in the query and the bytes in a multipart `media` field, then a robot message with `msgKey`/`msgParam` — `sampleFile` with `{ mediaId, fileName, fileType }`, `sampleImageMsg` with `{ photoURL: mediaId }`; this repository adds the Trigger-only route check, the per-reply count and size limits and its own failure counting), the callback field names (`msgId`, `senderStaffId`, `senderNick`, `conversationId`, `conversationType`, `isInAtList`, `sessionWebhook`, `sessionWebhookExpiredTime`, `robotCode`, `chatbotUserId`), the `messageFiles/download` request that turns an attachment's download code into a signed file URL and the bounded attachment `GET` (this repository adds its own HTTPS-only DingTalk/CDN host check, 30 s timeout and 20 MiB cap), trusted-reply-URL checks, text splitting and failure classification |
| `src/channels/dingtalk/dingtalk-bridge.mjs` | `src/sources/im/dingtalk-transport.ts` (`normalizeDingtalkCallback`, `trustedDingtalkDownloadUrl`, `DingtalkAttachmentRef`) and `src/sources/dingtalk.ts` (`saveDingtalkAttachments`, `dingtalkTrigger`) | The attachment references of a callback: `downloadCode`/`pictureDownloadCode` for a picture, a file's `downloadCode` and `fileName`, the rich-text picture entries and text entries, and the rule that a callback naming an attachment becomes a message rather than a non-text skip. The saving layout under the state directory, the path and file-name sanitization, the size and count limits, the Trigger text lines and `meta.attachments` are this repository's own |
| `src/channels/dingtalk/dingtalk-menu.mjs` | — (read only) | Read for the callback envelope shape and card topic; AI Cards, menus and streaming updates are deliberately **not** part of this adaptation |
| `src/channels/dingtalk/device-auth.mjs` | `src/sources/im/dingtalk-device-auth.ts` (`DingtalkDeviceAuth`), `src/sources/im/dingtalk-login.ts` (`DingtalkLoginManager`) and `src/app/http.ts` (`POST sources/dingtalk/login`, `GET sources/dingtalk/login/:loginId`) | The QR device-registration flow: `POST /app/registration/init` with `{ source: 'DING_DWS_CLAW' }` answering a nonce, `POST /app/registration/begin` with `{ nonce }` answering `device_code`, `verification_uri_complete`, `verification_uri`, `user_code`, `interval` and `expires_in`, and `POST /app/registration/poll` with `{ device_code }` answering an intermediate state (`WAITING`, `CREATING`, `PUBLISHING`, `APPROVING`) or a terminal one (`SUCCESS`, `FAIL`, `EXPIRED`) plus `client_id`/`client_secret` once issued. This repository keeps only start and poll, adds its own one-at-a-time ten-minute attempt, QR rendering with the public `qrcode` package, and the account creation that stores the provisioned Client ID and Secret in its own settings; unlike the attributed version it decides success by the presence of both credentials (DingTalk issues them at `APPROVING` too) and keeps polling through a state it does not know, instead of failing on any state other than `WAITING`. The secret never leaves the host |

Not adapted and not copied: the session, command, approval and delivery parts of `dingtalk-bridge.mjs`, `dingtalk-controller.mjs`,
`dingtalk-card-stream.mjs`, `config-store.mjs`, `state-store.mjs`, and every file under `src/channels/shared/`. Session binding,
commands, approvals, workspaces, deferred delivery and artifact delivery stay this repository's own Ticket, Outbox and Source
mechanisms.

### QQ

| Upstream file (dsh-im 5.10.0) | Adapted into (this repository) | What was adapted |
| --- | --- | --- |
| `src/channels/qq/qq-runtime.mjs` | `src/sources/im/qq-transport.ts` (`QqConnection`, `qqBotFactory`, `normalizeQqInbound`) | Creating the SDK's `QQBot` with the bot credentials over the WebSocket gateway (`transport: 'websocket'`, synchronous token prefetch), the `ready`/`resumed`/`error`/`message` handlers, the bounded wait for READY and the connection/start/stop ordering. This repository replaces dsh-im's embedded reconnect reporting with its Source loop's 5 s–60 s backoff, three-consecutive-error threshold and its own health reporting |
| `src/channels/qq/qq-controller.mjs` | `src/sources/im/qq-transport.ts` (`QqConnection`, `sendQqReply`) | The send path over the connected bot: `msg_id` and `msg_seq` on a passive reply, `markdownSupport: false` for the bot client, and the credential-free failure classification. The QR sign-in, credential store, workspace state and rename/delete flows are deliberately **not** part of this adaptation |
| `src/channels/qq/markdown-reply.mjs` | `src/sources/im/qq-transport.ts` (`sendQqPiece`, `sendQqReply`, `QQ_PASSIVE_REPLY_LIMIT`, `QQ_MARKDOWN_REJECTION_CODES`) | Markdown (`msg_type=2`) first and plain text (`msg_type=0`) on a definite markdown rejection, the passive reply budget of 4 direct / 5 group messages per inbound `msg_id`, and the rule that an uncertain delivery is never retried as a second transport |
| `src/channels/qq/qq-mention.mjs` | `src/sources/im/qq-transport.ts` (`addressedToBot`, `withoutSelfMention`, `normalizeQqInbound`, `qqMention`) | The group @-message decision from the raw event type, an `is_you` mention or an inline `<@id>` marker, learning the bot's own ids from READY, and stripping only the bot's own mention markers from the content |
| `src/channels/qq/qq-bridge.mjs` | `src/sources/im/qq-transport.ts` (`attachmentsOf`, `attachmentOf`, `trustedQqDownloadUrl`, `downloadQqAttachment`, `QQ_DOWNLOAD_HOSTS`, `QQ_IMAGE_FILENAME`) and `src/sources/qq.ts` (`saveQqAttachments`, `qqTrigger`) | The inbound attachment fields (`url`, `filename`, `content_type`/`contentType`, `size`), the rule that an `image/` Content-Type or a `.gif`/`.jpg`/`.jpeg`/`.png`/`.webp` file name makes a picture and anything else a file, the media host list (`myqcloud.com`, `qpic.cn`, `qq.com`, `qq.com.cn`, `tencentcos.com`, `ugcimg.cn`), the protocol-relative address completion and the file-buffer download. This repository adds its own HTTPS-only media-host check, redirect refusal, 30 s timeout and 20 MiB cap; the saving layout under the state directory, the path and file-name sanitization, the size and count limits, the Trigger text lines and `meta.attachments` are its own |
| `src/channels/shared/markdown-chunks.mjs` | `src/sources/im/qq-transport.ts` (`splitQqText`) | Line-break-aware text splitting for a reply longer than one QQ message |

Not adapted and not copied: the session, queue and artifact-delivery parts of `qq-bridge.mjs`, `qq-menu.mjs`, `config-store.mjs`,
`state-store.mjs`, `qr-auth.mjs`, `state-error.mjs`, `harness-client.mjs`, and every file under `src/channels/shared/`. Session
binding, commands, approvals, workspaces, deferred delivery and artifact delivery stay this repository's own Ticket, Outbox
and Source mechanisms. dsh-im's `qr-auth.mjs` was read only as background; this repository reimplements QQ's QR bind flow
itself (see below) and takes the AppID and AppSecret from its own settings.

### QQ QR bind flow — protocol behavior reimplemented, no code copied

`src/sources/im/qq-qr-auth.ts` and `src/sources/im/qq-login.ts` implement the QR sign-in (bind) flow whose observable
behavior Tencent's QQ Bot connector exposes. This repository **did not copy any code** from that package and does **not**
depend on it: `@tencent-connect/qqbot-connector` (upstream version 1.2.0) appears neither in `package.json` nor in the
lockfile. The protocol flow was reimplemented from its publicly observable behavior — the endpoint paths
(`https://q.qq.com/lite/create_bind_task`, `https://q.qq.com/lite/poll_bind_result`), the `{key}` / `{task_id}` request
payloads, the connect-page address
`https://q.qq.com/qqbot/openclaw/connect.html?task_id=<task_id>&source=<source>&_wv=2`, the numeric statuses
(`0` none, `1` pending, `2` completed, `3` expired), the `bot_appid` / `bot_encrypt_secret` / `user_openid` answer fields,
and the AES-256-GCM layout of `bot_encrypt_secret` (base64: the first 12 bytes are the IV, the last 16 the auth tag, the
middle the ciphertext, keyed by the local base64 32-byte key). The QR attempt lifecycle, the QR rendering with the public
`qrcode` package, the account creation with the scanning person on its allow-list, the 15 s no-redirect HTTPS-only calls
and the sanitized failures are this repository's own.

### WeChat (iLink)

| Upstream file (dsh-im 5.10.0) | Adapted into (this repository) | What was adapted |
| --- | --- | --- |
| `src/channels/weixin/weixin-api.mjs` | `src/sources/im/weixin-transport.ts` (`beginWeixinLogin`, `pollWeixinLogin`, `getWeixinUpdates`, `sendWeixinText`, `normalizeWeixinInbound`, `splitWeixinText`) and `src/sources/im/weixin-login.ts` (`renderWeixinQrImage`) | The iLink base URL and protocol version 2.4.6, the `iLink-App-Id`/`iLink-App-ClientVersion`/`X-WECHAT-UIN` headers, the bot-token bearer and `AuthorizationType`, the `base_info` payload, the QR handshake (`ilink/bot/get_bot_qrcode?bot_type=3` with `local_token_list`, `ilink/bot/get_qrcode_status`) and its statuses, the `ilink/bot/getupdates` long poll with its `get_updates_buf` cursor (a timeout means no messages), the `ilink/bot/sendmessage` text item with `context_token` and `run_id`, the `message_type` 2 self-message skip, text and voice-transcript extraction, the 1,800-character line-break-aware splitter, trusted-WeChat-URL checks, the `ret`/`errcode` rejection codes and the `-14` stale token, and the failure classification (`network`, `timeout`, `auth`, `rate-limit`, `rejected`, `invalid-response`). The reply-quote snapshot, typing indicator and proactive-delivery paths are deliberately **not** part of this adaptation; the inbound attachment path is adapted in the next row, while the outbound image/file upload and CDN artifact delivery are **not** added |
| `src/channels/weixin/weixin-api.mjs` (inbound attachments) | `src/sources/im/weixin-transport.ts` (`parseWeixinAesKey`, `decryptWeixinAttachment`, `weixinAttachmentDownloadUrl`, `downloadWeixinAttachment`, `sniffWeixinImageMime`, `normalizeWeixinInbound`) and `src/sources/wechat.ts` (`saveWechatAttachments`, `wechatTrigger`) | The inbound image/file path: `item_list[].image_item` and `item_list[].file_item` (its `file_name` and `len`), the two AES key encodings (`aeskey` as 32 hex digits, `media.aes_key` as base64 of the 16 bytes or of their 32 hex digits), the `aes-128-ecb` decryption of whole AES-block ciphertext, the encrypted CDN download address (`media.encrypt_query_param` encoded onto `https://novac2c.cdn.weixin.qq.com/c2c/download`, or a trusted `media.full_url` on exactly that host with a `/c2c/` path, no credentials and the standard port), and the download-and-decrypt of an image or a file. This repository adds its own redirect refusal, 30 s timeout, 20 MiB ciphertext cap, at-most-five-per-message rule, MIME sniffing of a decrypted picture, and the saving layout under the state directory with the path and name sanitization, the Trigger text lines and `meta.attachments`; the signed address, its query string and the key never reach a log line, a health detail or a Trigger |
| `src/channels/weixin/weixin-runtime.mjs` | `src/sources/im/weixin-login.ts` (`WeixinLoginManager`), `src/sources/wechat.ts` (`watchWechat`, `runWechatInstance`) | The status monitor over `getupdates` (an ordered batch, a cursor committed after handling, three consecutive failures then a backoff), the single attempt that receives one confirmed credential, and the stop/start ordering. This repository replaces dsh-im's Harness bridge and reply bookkeeping with its own Ticket, Outbox and Channel mechanisms |
| `src/channels/weixin/weixin-controller.mjs` | `src/sources/im/weixin-login.ts` (`WeixinLoginManager`), `src/app/http.ts` (`POST sources/:id/wechat/login`, `GET sources/:id/wechat/login/:loginId`, `GET sources/:id/wechat/status`) | The QR attempt lifecycle: a five-minute attempt, only the newest attempt of an account kept, the `confirmed` answer's `bot_token`/`ilink_bot_id`/`ilink_user_id`, the expired state allowing a new attempt, and the account metadata kept beside the credential. The config store, credential store, per-account runtime supervisor and the panel RPC layer are **not** adapted: the credential is written to this repository's own KV record and the token never leaves the host |

Not adapted and not copied: `weixin-bridge.mjs`, `weixin-controller.mjs`'s config/credential stores and supervisor,
`config-store.mjs`, `state-store.mjs`, `connection-error.mjs`, `harness-client.mjs`, and every file under
`src/channels/shared/`. Session binding, commands, approvals, workspaces, deferred delivery and artifact delivery stay this
repository's own Ticket, Outbox and Source mechanisms. Group chats, outbound media messages and proactive delivery are out
of scope for this adaptation.

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
copied into this repository. Its own package carries its license. That package renders a QR code as a PNG data URL: the
WeChat Source renders QR content that is not already a trusted image answer, and the DingTalk Source renders the
`verification_uri_complete` of its device registration; the dependency is loaded lazily and is not part of the panel
bundle.

## dingtalk-stream — npm dependency

`dingtalk-stream` 2.1.4 (the official DingTalk Stream Mode Node.js SDK, MIT License, Copyright the DingTalk open-platform
team) is installed from npm as a normal dependency and is not copied into this repository. Its own package carries its
license; the DingTalk Source builds on its client and topic constants.

## @tencent-connect/qqbot-nodejs — npm dependency

`@tencent-connect/qqbot-nodejs` 1.0.4 (the QQ Open Platform Node.js SDK, MIT License, Copyright Tencent) is installed from
npm as a normal dependency and is not copied into this repository. Its own package carries its license; the QQ Source
builds on its `QQBot` WebSocket gateway client, its passive reply send path and its `ApiError` failure shape (read
structurally, so the transport module does not import the SDK; only the production bot factory loads it, lazily).

`@tencent-connect/qqbot-connector` 1.2.0 is deliberately **not** a dependency: its upstream package is marked
`UNLICENSED`, so it is neither redistributed nor installed here. Its QR-code sign-in behavior is the protocol flow this
repository reimplements itself in `src/sources/im/qq-qr-auth.ts` and `src/sources/im/qq-login.ts` (see the QQ QR bind flow
section above): no code of the package was copied, and the AppID and AppSecret it would provision are stored in this
installation's own settings instead.

## Upgrading

When dsh-im is upgraded upstream, diff its `src/channels/dingtalk/`, `src/channels/qq/` and `src/channels/weixin/` against
the tables above and merge protocol changes by hand (for QQ also the shared `markdown-chunks.mjs`). This repository pins
the adapted version in this file (5.10.0) and never adds `@xmanrui/dsh-im` as a dependency.
