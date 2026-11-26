# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **A local folder Source, on by default.** A new installation seeds one `folder` instance: drop a file or a task folder into its inbox and it becomes an explicit request from the operator; replies and artifacts land in its outbox. See [Default local folder](#default-local-folder).
- **A remote folder Source (optional).** An instance watches an inbox on another host over SFTP, using a dedicated SSH key and a strictly checked host key; replies are written to its remote outbox, and handled files move into `.done`. See [Remote folder over SFTP](#remote-folder-over-sftp).
- **A web page/feed Source (optional).** An instance polls a public RSS/Atom feed or JSON address and starts work on every item it has not seen before. The Source is read-only — an item has no reply route — and its requests pass an SSRF guard. See [Web page or feed](#web-page-or-feed).
- **An agent GitHub account (optional).** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account. An installation whose GitHub Source names no repository runs without GitHub: its `gh` fails, and its other Sources work as they do with one.
- **Optional:** a Feishu bot for chat requests. The twelve-kind Source catalog also lists Gitee, Telegram, WeCom app and Email, whose accounts can be saved now while their connections are still being developed. A WeChat account is a personal WeChat signed in by scanning a QR code; it receives direct messages — text, pictures and files — from the people on its Policy list, and group messages are not received yet.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for each instance's repository, account, allowed list, rules and prompts, and Settings for the installation-wide Eval, Executor and deployment settings.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- GitHub CLI (`gh`) 2.48 or later, only for a GitHub Source. Source CLI fields must point to `gh` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- For a remote folder Source: the OpenSSH client (`sftp` and `ssh-keygen`) on the `PATH` of the dsh-superagent process, and an SSH key the remote host accepts.
- For a web page/feed Source: outbound http(s) access from the dsh-superagent process to the addresses it polls; no credential, key or extra program is needed.
- For a GitHub Source, a repository on github.com; GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if that repository uses Git LFS.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot
- For DingTalk: an enterprise-internal DingTalk application with the robot capability, its Client ID, Client Secret and Robot Code. The bot uses Stream mode, so no public address or inbound port is needed
- For QQ: a QQ open-platform bot with its AppID and AppSecret. It connects to the bot gateway over a WebSocket long connection, so no public address or inbound port is needed; a test bot can use QQ's sandbox environment
- For WeChat: a **separate personal WeChat account** for the bot and a phone that can scan a QR code with it. No public address, inbound port or SDK is involved. Automating a personal account is against Tencent's terms and risks that account being restricted: use a dedicated account, never a personal main account, and keep the allowed list small. See [WeChat account](#wechat-account-optional-ilink-qr-sign-in)

## Accounts

### Agent GitHub account (optional)

Skip this section when the GitHub Source names no repository: setup then writes no GitHub credential helper and its `gh` shim says the installation has no GitHub account.

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

### DingTalk bot (optional, Stream mode)

1. Create an **enterprise-internal application** in the [DingTalk open platform](https://open.dingtalk.com/) and add the robot capability to it. Its **Credentials** page shows the **Client ID** (AppKey) and **Client Secret** (AppSecret); the robot's page shows its **Robot Code**. dsh-superagent asks for exactly those three values, because the robot authenticates and sends as that application.
2. Choose **Stream mode** as the robot's message-receiving mode. No public callback URL, inbound port or public address is involved: dsh-superagent opens the long connection itself with the public `dingtalk-stream` SDK.
3. Grant the application the permissions it uses: receive messages sent to the robot, and send messages as the robot. For group conversations, also grant the permission to send a message to a group; without it, a reply whose session webhook expired cannot be delivered through the robot API, and the instance's health names the failure.
4. Publish the application version after changing permissions. An unpublished permission does not reach the running bot.
5. Add the bot to the groups it should listen to, or leave it to be messaged directly.

Add a **DingTalk** account in the panel (**Add Source**, then the account's page) and fill in Client ID, Client Secret and Robot Code. Saving performs no network check: a wrong credential, a bot outside the organization, or a missing permission shows in that instance's health (`starting` while it retries, `error` after three consecutive failed connections, with the connection stage and reason), and never keeps the save from being stored. The connection is retried with a 5 s to 60 s backoff; a bot whose three credentials are still empty reports `paused`.

A direct message, and a group message that mentions the bot, become a request. The bot's own messages, other bots' messages and messages of an unsupported type (voice, video, an empty rich-text card) are counted in the instance's health and never become Tickets. The instance's optional **Allowed sender staff ids** (comma-separated, or an array through `PUT settings/source:<instance id>`) is an early receiving filter in front of the Policy: when it names anyone, only their messages are listened to; it authorizes nothing by itself, the Policy's **allowed** list of staff ids still decides who may originate work. Group messages are received only when they mention the bot; direct messages always are.

A reply goes back to the Trigger's own conversation only: first to the message's `sessionWebhook` while it is fresh (the Trigger stores its expiry), and through the robot API once it expired — `groupMessages/send` for a group, `oToMessages/batchSend` for a person. A group reply mentions its sender with DingTalk's native `at` field. A conversation DingTalk no longer knows settles the message as dropped instead of resending it elsewhere. The Client Secret stays in this installation's settings: it is never written to a log, a health detail or a Trigger, and the Trigger carries only the conversation ids and the session webhook.

Inbound pictures and files are supported: a picture, a file or a rich-text message that mentions the bot is downloaded before it becomes work — the callback's download code is exchanged through `messageFiles/download` with the instance's own robot code, then the bytes are fetched over a bounded 30 s HTTPS `GET` that must target a DingTalk or its Alibaba CDN host — and saved under `<stateDir>/area/attachments/dingtalk/<instance>/<messageId>/`. The Trigger's text carries the original text (when DingTalk sent one) and one `附件：<absolute path>（<kind>/<mime>）` line per saved file, or `收到图片/文件：<absolute path>` when there is no text at all; `meta.attachments` holds `{ path, kind, name, mime, bytes }` with the same absolute paths, so the worker reads the files itself. A message with more than five attachments, a file larger than 20 MiB, an attachment without a download reference, a failed download or a download address outside DingTalk becomes no request: it is counted as `skipped` in the instance's health and opens no Ticket.

Outbound files are supported for a ticket's result: a ready ticket's deliverables are returned to the Trigger's own conversation beside the result text. Each file is read from the ticket directory's `deliver/`, uploaded through `POST https://oapi.dingtalk.com/media/upload` with the instance's access token and the bytes as the multipart `media` field — typed `image` when the MIME type is `image/*`, `file` otherwise — and sent to the same route as the text: `sampleImageMsg` with the `media_id` as `photoURL` for a picture, `sampleFile` with `{ mediaId, fileName, fileType }` for every other type. One reply delivers at most 10 files of at most 20 MiB each. A skipped or failed file is counted in the instance's health (`<n> reply attachments could not be delivered`) and never fails the message: the text is already out, so it is not sent again. The other IM channels ignore a message's files and keep delivering text only.

### QQ bot (optional, bot gateway)

1. Create a **bot** in the [QQ open platform](https://bot.q.qq.com/) (QQ 开放平台) and finish the developer verification it asks for. The bot's page under **开发管理** shows its **AppID**, and the **AppSecret** is shown once there; reset it if it was lost. dsh-superagent asks for exactly those two values.
2. A new bot starts in the **sandbox environment** (沙箱环境): only accounts added under **沙箱配置** can message it, and those messages are for testing. Turn on the bot's **sandbox switch** in its Source account for that phase. Switch the quality-assurance work to the production environment only after the bot passes review and the sandbox switch is off; the credentials are the same in both.
3. Grant the bot the permissions it uses: receive direct messages and group messages that mention it, and send messages back to those conversations. Add the bot to the groups it should listen to, or leave it to be messaged directly.
4. No public callback URL or inbound port is involved: dsh-superagent opens the WebSocket long connection to the bot gateway itself with the public `@tencent-connect/qqbot-nodejs` SDK, and the SDK's heartbeat and RESUME keep a transient drop from losing the connection.

Add a **QQ** account in the panel (**Add Source**, then the account's page) and fill in AppID and AppSecret. Saving performs no network check: a wrong credential, a bot that is not online, or a missing permission shows in that instance's health (`starting` while it retries, `error` after three consecutive failed connections, with the connection stage and reason), and never keeps the save from being stored. The connection is retried with a 5 s to 60 s backoff; a bot whose two credentials are still empty reports `paused`.

A direct message, and a group message that mentions the bot, become a request. The bot's own messages, other bots' messages and messages with neither text nor an attachment are counted in the instance's health and never become Tickets. The instance's optional **Allowed sender openids** (comma-separated, or an array through `PUT settings/source:<instance id>`) is an early receiving filter in front of the Policy: when it names anyone, only their messages are listened to; it authorizes nothing by itself, the Policy's **allowed** list of QQ user openids still decides who may originate work. Copy the openids from the bot's own message events or the panel's Trigger rows; they are per-bot identifiers, not QQ numbers.

A reply is a **passive reply**: it carries the inbound message's `msg_id` and a `msg_seq` derived from the outgoing message id, so a retry that crosses a delivered message is deduplicated by QQ rather than posted twice. QQ accepts a passive reply within a bounded window — 60 minutes for a direct message (4 replies) and 60 minutes for a group message (5 replies; some document versions still say 5 minutes) — and this Source never falls back to proactive messages, whose quota QQ limits per user and per day: a reply whose window has already closed, whose `msg_id` QQ no longer accepts, or whose conversation no longer receives settles as dropped instead of being sent elsewhere. A reply longer than the passive budget is cut at the budget's last slot with a truncation notice. Group replies may mention their sender with QQ's inline `<@openid>` markup; the transport sends replies as markdown first (QQ renders the mention, links and formatting there) and falls back to plain text on a definite markdown rejection. The AppSecret stays in this installation's settings: it is never written to a log, a health detail or a Trigger, and the Trigger carries only the conversation ids and the message id.

Inbound pictures and files are supported: a message QQ names an attachment on — a picture when its Content-Type starts with `image/` or its file name ends in `.gif`, `.jpg`, `.jpeg`, `.png` or `.webp`, any other file otherwise, and even a message with no text at all — is downloaded before it becomes work. Only a signed HTTPS address on a QQ media host (`.myqcloud.com`, `.qpic.cn`, `.qq.com`, `.qq.com.cn`, `.tencentcos.com`, `.ugcimg.cn`) is fetched: a redirect is never followed, an IP literal, a credential or a port other than 443 is refused, the request is bounded to 30 s and 20 MiB, and one message may carry at most five attachments. The bytes are saved under `<stateDir>/area/attachments/qq/<instance>/<messageId>/` (directories `0700`, files `0600`, file names reduced to `[A-Za-z0-9._-]` so a server-supplied name can never leave the directory, pictures named from the Content-Type with an unknown type kept as `.bin`). The Trigger's text carries the original text (when QQ sent one) and one `附件：<absolute path>（<kind>/<mime>）` line per saved file, or `收到图片/文件：<absolute path>` when there is no text at all; `meta.attachments` holds `{ path, kind, name, mime, bytes }` with the same absolute paths, so the worker reads the files itself. A message with more than five attachments, an attachment larger than 20 MiB, an attachment without a download address, a failed or redirected download or an address outside the QQ media hosts becomes no request: it is counted as `skipped` in the instance's health and opens no Ticket, and the signed address and its query string never reach a log line, a health detail or a Trigger. Outbound messages are still text only: a reply carries no attachment.

### WeChat account (optional, iLink QR sign-in)

> **Risk.** This Source automates a **personal WeChat account** through Tencent's iLink bot service. Tencent's terms do not cover an account used this way, and it may be restricted or banned. Use a dedicated account that nothing else depends on, keep the allowed list small, and expect to sign in again when the session ends. Do not point it at a personal main account.

1. Create or pick a **separate personal WeChat account** for the agent and keep its phone at hand: the sign-in is a QR code scanned in WeChat on that phone. There is no app to register and no credential to type.
2. Add a **WeChat** account in the panel (**Settings → Source types → WeChat → Add account**) and save it; the account needs no fields (the bot type defaults to 3). Saving performs no network check and does not block on the sign-in.
3. In the saved account's row choose **Sign in with QR code**. The panel shows the QR code iLink returned, polls it every two seconds and reports when it is scanned and when it is confirmed; a code is valid for five minutes, and an expired code offers **Refresh QR code**. On confirmation the account id and sign-in time replace the button, and **Sign in again** repeats the flow at any time.
4. The account's **Policy and prompts** part decides who may ask for work: add each WeChat user id (`from_user_id`) to the Policy's **allowed** list — copy it from the panel's Trigger rows — and save. Only a direct message from someone on that list becomes a request; there is no other receiving filter.
5. dsh-superagent long-polls iLink for messages from then on. The instance's health entry is `ready` with the messages received, duplicates, skipped messages and attachments it could not receive, `paused` with **Needs a WeChat QR sign-in** while no account is signed in, and `error` with **The WeChat sign-in expired; sign in again** when iLink no longer accepts the token (the account then waits for a new sign-in; no restart is needed).

This Source receives **direct messages**: text, pictures and files, and a message with no text at all becomes a request too. The account's own messages, group messages and messages that carry neither text nor an attachment are counted in the instance's health and never become Tickets. Inbound pictures and files are supported: a message iLink names an `image_item` or a `file_item` on is downloaded and decrypted before it becomes work. Only the encrypted download address under `https://novac2c.cdn.weixin.qq.com/c2c/` (built from `media.encrypt_query_param`, or a `full_url` on exactly that host and path) is fetched: a redirect is never followed, an address with credentials or a port other than 443 is refused, the request is bounded to 30 s and the ciphertext to 20 MiB plus one AES block, and one message may carry at most five attachments. The bytes are decrypted with `aes-128-ecb` and the key iLink sent (`aeskey` as 32 hex digits, or `media.aes_key` as base64) and saved under `<stateDir>/area/attachments/wechat/<instance>/<messageId>/` (directories `0700`, files `0600`; only the last path segment of the name iLink sent is used and it is reduced to `[A-Za-z0-9._-]`, so a name like `../../etc/passwd` can never leave the directory, and pictures are named from their decrypted bytes with an unknown type kept as `.bin`). The Trigger's text carries the original text (when iLink sent one) and one `附件：<absolute path>（<kind>/<mime>）` line per saved file, or `收到图片/文件：<absolute path>` when there is no text at all; `meta.attachments` holds `{ path, kind, name, mime, bytes }` with the same absolute paths, so the worker reads the files itself. A message with more than five attachments, an attachment larger than 20 MiB, an attachment without a usable download address or key, a failed or redirected download and an undecryptable body becomes no request: it is counted as `skipped` in the instance's health and opens no Ticket, and the signed address and its query string never reach a log line, a health detail or a Trigger. Group auto-replies are **not available** on this transport: Tencent's iLink bot service exposes only direct conversations for a personal account, with no group or room identity to listen to or reply in. For group work use the WeCom app Source (an enterprise app can receive group callbacks) or a Feishu/DingTalk group bot instead. A voice message iLink has already transcribed is read as text. A reply goes back to the sender's own direct chat only, as one or more text messages of at most 1,800 characters, each carrying the inbound message's conversation token and message id; a reply that fails to send is retried by the Outbox, and a conversation that can no longer receive it is dropped rather than sent elsewhere. Outbound messages are still text only: a reply carries no attachment. There is no way to add a friend, start a group or send a message to anyone else from this Source.

The bot token is **not** part of the account's settings: the QR sign-in writes it to this installation's state database under `weixin.token:<instance>`, and the panel, the health entries and the Triggers carry only the account id and sign-in time. Signing in again replaces the old token and restarts that instance's poll loop without restarting dsh-superagent. Removing the account removes its configuration; the record left in the state database can be deleted with the state directory.

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Each Source instance's page edits its own configuration. A new installation starts with one **local folder** instance and nothing else; a **remote folder**, a **web page/feed**, GitHub, Feishu, QQ, DingTalk, WeChat and the other kinds are added with **Add Source**, which creates a named instance of an installed kind. For a remote folder, set the host, user, the two absolute local key-file paths and the remote inbox and outbox; see [Remote folder over SFTP](#remote-folder-over-sftp). For a web page/feed, set the public RSS/Atom or JSON address and whether the first poll only records the current items or starts work on all of them; see [Web page or feed](#web-page-or-feed). For GitHub, set the repository (`owner/name`) and agent CLI, for example `/home/me/.local/bin/gh-agent`. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages. For DingTalk, set the enterprise app's Client ID, Client Secret and Robot Code; the bot connects over Stream mode and needs no callback URL. For QQ, set the open-platform bot's AppID and AppSecret (and its sandbox switch while testing); the bot connects over the bot gateway's WebSocket and needs no callback URL. For WeChat, save the account and sign it in with a QR code; there is nothing to fill in besides the bot type, and the account id and sign-in time appear once it is confirmed — see [WeChat account](#wechat-account-optional-ilink-qr-sign-in). The catalog also offers Gitee, Telegram, WeCom app and Email as **coming soon**: an account saves, but the kind receives and sends nothing yet and its card stays paused. An instance with no open Ticket can be deleted from its page; its historical Tickets stay readable.
2. **Policy and prompts, per Source.** An installed instance's page has a **Policy and prompts** section (策略提示配置). Its **Policy** holds the accept rules the instance's work is assessed by — the installation's default rules until the instance saves its own — plus the allowed GitHub accounts and Feishu users who may ask for work, the bot list and the admission table. Until a list has someone, no request through that instance can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**. Its **Prompts** holds the prompt configuration its Tickets' workers read; a default skill of the instance's kind is shown read-only. The installation default rules and configuration, which the main Session reads, are not edited from the panel: change them through the main Session's settings and prompt tools or the management API.
3. **Routing and Eval.** The header gear's Routing and Eval group sets the accept mode, the Eval timeout and the assessment model, and shows the history of Policy and Eval saves. A rule or admission change on a Source page saves that Source's Policy block; saving an Eval setting saves the Eval block. Each save uses its own revision.
4. **Executor and environment.** The header gear's Executor and environment group sets the directory root and a prepare command. To give each Ticket a checkout of the repository:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands.

### Default local folder

The first start of a new installation seeds one local folder Source, so dropping a file needs no setup:

- Instance `folder`, label **本地文件夹**, enabled, polling every 10 seconds.
- Inbox `<stateDir>/area/local/inbox` and outbox `<stateDir>/area/local/outbox`, separate from the workspace and its Tickets. Both directories are created with the instance; change them on the instance's page.
- `operator`: the OS user name that runs dsh-superagent; drops are attributed to it.
- Policy part `sources.folder`: `allowed` names that operator, and the admission table keeps its defaults, so only the operator's direct drops start work.

The seed runs once, after startup, and its one-time record is the KV entry `saa.defaults.seeded`. Deleting the instance later does not bring it back; an installation that already has a folder instance (such as `folder:ops`) keeps it as configured and only gets the record. A failed seed writes no record, so the next start tries again.

A drop is a file (its name and content are the request) or a task folder with `TASK.md`; both are delivered back to the outbox, under the Ticket's id. Deleting the outbox makes later replies undeliverable until the directory is made again.

### Remote folder over SFTP

A remote folder Source applies the local folder's drop model to another host, such as a PC that runs no DeepSeek Harness: an operator copies a file into the remote inbox, the instance reads it over SFTP, and the Ticket's replies are written into the remote outbox. The transport runs `sftp` with an argument array (never a shell) and a batch on standard input. It authenticates with a key only and checks the host key strictly, so this installation stores no password, reads no private-key content and runs no shell on the host.

Configure one instance on its page (**Add Source**, then the instance's settings), or with `PUT settings/source:<instance id>`:

| Field | Meaning |
| --- | --- |
| `host`, `port`, `username` | The SSH host (a name or address), port (22 by default) and the remote user |
| `identityFile` | Absolute local path of the private key, passed to `sftp` with `-i` |
| `knownHosts` | Absolute local path of the known_hosts file, read with `StrictHostKeyChecking=yes` |
| `hostKeySha256` | Optional `SHA256:…` pin; when set, `ssh-keygen -F` compares it against the known hosts file before every round and a mismatch fails it |
| `inbox`, `outbox` | Absolute POSIX paths on the host, such as `/srv/dropbox/inbox`; only letters, digits and `. _ - /`, with no `..`, empty segment, space, quote or wildcard |
| `pollSeconds` | 30 by default, at least 5 |
| `maxFileBytes` | 1 MiB by default, from 1 KiB to 16 MiB; a larger file is skipped and named in the health detail |
| `operator` | The person a drop is attributed to; empty is the OS user name. The Policy's `allowed` list names it |

Prepare a dedicated key and the known hosts file on the machine that runs dsh-superagent:

```sh
# A dedicated key for this Source. BatchMode=yes cannot prompt, so use a key without a passphrase, or load a
# passphrase-protected one into the ssh-agent of the dsh-superagent process.
ssh-keygen -t ed25519 -N '' -C dsh-superagent-remote -f ~/.ssh/dsh-superagent-remote

# Known hosts: copy the host's line from a known_hosts you already verified, or scan it once and compare the
# fingerprint with the one `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints on the host.
ssh-keyscan -t ed25519 files.example > ~/.ssh/dsh-superagent-known-hosts
ssh-keygen -l -f ~/.ssh/dsh-superagent-known-hosts
```

Put the key's public half into the remote account's `authorized_keys`, restricted to SFTP, and give the remote account only its own drop directories. On the remote host, a minimal `sshd` configuration dedicated to that account:

```
# /etc/ssh/sshd_config.d/dsh-superagent-remote.conf
# authorized_keys: restrict,command="internal-sftp" ssh-ed25519 AAAA… dsh-superagent
Match User dsh-remote
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  PubkeyAuthentication yes
  PermitTTY no
  AllowTcpForwarding no
  X11Forwarding no
  ForceCommand internal-sftp
  ChrootDirectory /srv/dsh-remote
```

With the chroot above, the inbox and outbox are `/inbox` and `/outbox` as the account sees them; make `/srv/dsh-remote` owned by root and its `inbox`/`outbox` directories writable by `dsh-remote`, and leave the account no shell.

A polling round lists the inbox and downloads each candidate file into `<stateDir>/area/remote.tmp/<instance>/`, at most 20 files a round. Hidden entries (including `.done`) and names outside the path alphabet are skipped, as are files larger than `maxFileBytes`; the instance's health detail names the skipped ones and how many files wait for the next round. Each file's UTF-8 text (up to 8,000 characters) becomes the Trigger, and the file is renamed into `<inbox>/.done` once it was received; a failed round keeps the file and counts toward the same three-consecutive-failures health error as the other Sources. The per-instance seen hash remembers a file already received, so a file whose archiving failed is not received twice. A reply is written as `<outbox>/<message id>.md`; a retry of the same message id overwrites the same name. Deleting the remote outbox makes later replies fail as retryable errors.

The remote folder never uses a password, never disables host key checking (`StrictHostKeyChecking=yes` and no `accept-new`), never runs a shell command on the host and never logs a private key: only its path appears in the configuration and the argument array. An account can be saved before it is complete; until `host`, `username`, the two local key paths, `inbox` and `outbox` are set, the instance reports `paused` with what it waits for.

### Web page or feed

A **web page or feed** Source turns a public RSS/Atom feed or JSON address into work without a chat or a mailbox: every item the instance has not seen before becomes a Trigger attributed to the instance's operator. It suits announcements, blogs, release notes or any published JSON list. The Source is **read-only**: an item has no reply route, so a kind without a Channel posts no reply back to the feed and needs no `@` syntax — the result is read in the panel and the Ticket's own history.

Configure one instance on its page (**Add Source**, then the instance's settings), or with `PUT settings/source:<instance id>`:

| Field | Meaning |
| --- | --- |
| `url` | The public http/https address to poll: an RSS/Atom feed or a JSON document |
| `format` | `auto` (default) reads the answer's Content-Type and opening bytes; `rss`, `atom` or `json` forces the parser |
| `baseline` | `latest` (default) records the items present on the first poll without starting work; `all` starts work on every one of them |
| `pollSeconds` | 300 by default, at least 30 |
| `maxItemsPerPoll` | 10 by default, from 1 to 50; new items beyond it wait for the next poll, and the health detail names how many |
| `jsonItemsPath`, `jsonIdPath`, `jsonTitlePath`, `jsonLinkPath`, `jsonSummaryPath` | Dot paths into the JSON document, defaulting to `items`, `id`, `title`, `url` and `summary`; an empty items path reads the document's root array |
| `operator` | The person an item is reported for; `web` by default, and empty falls back to the OS user name |

RSS items are read from `item` (`title`, `link`, `guid`, `pubDate`, `description`), Atom entries from `entry` (`id`, `title`, `link[href]`, `updated`, `summary`) and JSON items by the configured dot paths. An item without an id uses its link, and without either a hash of its title and summary, so the same item is never received twice. The Trigger text is the item's title, link and summary (up to 8,000 characters), its Thread is `web:<instance>:<item id>` and the operator is its reporter. A seen item id is remembered for seven days (at most 1,000 ids), and the instance's health detail counts what a round read, how many new items it received, how many it skipped and how many wait.

Every request carries the same SSRF guard: http and https only; no user name or password in the address; no `localhost`, `.local`, loopback, private, link-local or unique-local address. A host name is resolved and **every** address it names must be public. A redirect is followed at most three times and every hop is checked again, so a public feed cannot redirect the Source into the private network; a `file:` or other scheme is refused. Requests time out after 20 seconds, carry the `dsh-superagent/web` User-Agent and read at most 2 MiB of an answer. The address is checked again on every poll, and a save refuses an address that already names a local or private host.

An account can be saved before it is complete; until `url` is set, the instance reports `paused` with what it waits for. The first poll reports `ready` with `baseline recorded the current items`. HTTP, parse, SSRF and timeout failures count toward the same three-consecutive-failures health error as the other Sources, which a later good poll clears.

Unlike the other Source kinds, the web kind has **no Policy part** (no allowed list, no admission table and no Policy form). To admit its operator, save the instance's `policy:<instance id>` block through the management API with an `allowed` list; until that list names the operator, a received item is filtered as `not_a_member`. See [Management API](#management-api).

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, `problems`, the setup problems of named GitHub and Feishu instances by instance id, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, `revision`, its kind's form, and its setup `problem` when it has one; each installed instance's `policy`: its kind's `fields`, the `explicit` wording, its admission `rows` and `sync` when the kind has them, the block `revision` of `policy:<id>`, the `rules` that apply to its work, `inherited` — whether they are the installation's defaults rather than its own — and its Policy `value`; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET source-kinds` | The installed Source kinds the add-Source form offers: `kind`, `title`, `description`, `fields`, `defaults` and `placeholder`, which is true for a kind whose connection is still being developed (an account saves but receives nothing) |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `DELETE sources/<id>` | Deletes a Source instance's configuration, and its Policy part with it: `deleted: true`. An unknown id is 404 `unknownSource`; an instance still owning an open Ticket is 409 `sourceInUse` with the Ticket `count`. Its historical Tickets stay stored and readable |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `<block>` is `policy`, `eval`, `executor`, `source:<instance id>` or `policy:<instance id>`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused only when setup, Feishu and every named instance are already healthy |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the installation's default prompt configuration, which the main Session reads and an unsaved Source inherits: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, `skillPrefix`, which Sessions load a skill's name under, and `defaultSkills`, the default skills of the configured Source kinds. Or saves it: the new `revision` |
| `GET sources/<id>/prompts`, `PUT sources/<id>/prompts` with `{"config", "baseRevision"}`, `POST sources/<id>/prompts/preview` | Reads, saves or previews one Source instance's own prompt configuration, which its Tickets' worker Sessions read: the same view, with `source` and the instance kind's `defaultSkills`, or the new `revision`. An instance that never saved shows the inherited installation configuration |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `feishu`, `folder`, `remote`, `web`, `qq`, `dingtalk`, `wechat`, `history` | Source polling, events and history recovery. Every instance also has its own entry named by its instance id: `<kind>` for a stored instance named after its kind (such as `folder` or `github`), and `<kind>:<key>` for a named one, such as `github:acme-aps`. A remote folder instance's detail names the files a round skipped and the files that wait for the next round. A web instance's detail counts the items a round read, how many new items it received, how many it skipped and how many wait for the next round, and states when the first poll recorded the current items instead of starting work. A QQ instance's detail names the connection stage and the reason of its last failure, and counts the messages it received, the bot messages and empty messages it skipped, the attachments it could not receive, and the duplicates; while reconnecting it names the backoff delay. A DingTalk instance's detail names the connection stage and the reason of its last failure, and counts the messages it received, the bot and non-text callbacks it skipped, the duplicates, and the reply attachments it could not deliver. A WeChat instance's detail counts the messages it received, the group, own and empty messages it skipped, the attachments it could not receive, and the duplicates; it is `paused` with `wechatLogin` until the account is signed in by QR code, and `error` with `wechatSignInExpired` when iLink no longer accepts the token. A placeholder kind's instances report `paused` with the code `placeholder` |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision, or a Source still owning open Tickets (`sourceInUse`).
- 500: anything else.

The blocks:

- `source:github`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `source:<instance id>`: the id is the kind for a Source stored before instances, else `<kind>:<key>`. A folder Source is one inbox per instance and its config has `inbox`, `outbox`, `operator` and `pollSeconds`; the upgrade turns each old row into `source:folder:<row id>`, and the seeded default is `source:folder`. A remote folder Source's config has `host`, `port`, `username`, `identityFile`, `knownHosts`, `hostKeySha256`, `inbox`, `outbox`, `pollSeconds`, `maxFileBytes` and `operator`; it stores paths only, never a key or a password. A web page/feed Source's config has `url`, `format`, `baseline`, `pollSeconds`, `maxItemsPerPoll`, the five `json*` dot paths and `operator`; it stores a public address only, never a credential.
- `policy`: the installation's Policy: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `policy:<instance id>`: that Source instance's own Policy part: its kind's fields (such as `allowed`, `bots` and `syncChat`), its `admission` table, and optionally its own `rules` — the same rule shape as the installation's `rules`. Absent `rules` inherits the installation's default rules; a saved list replaces them for that instance only.
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `directory`, `prepare` and `blockedCommands`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

A Source's own Policy is saved the same way, with the `policy:<instance id>` revision from `GET settings` (`sources[].policy.revision`):

```sh
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .policy.revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/policy:github \
  -d "{\"value\": {\"allowed\": [{\"id\": \"octocat\"}], \"bots\": [], \"admission\": {}, \"rules\": []}, \"revision\": $rev}"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the GitHub repository and the agent's push access when the GitHub Source names a repository, writes the worker environment, and checks that git uses only the agent credentials for github.com. Without a repository it skips both GitHub checks: workers get a `gh` shim that fails for want of an account, and git gets no github.com credential helper. A Feishu setup failure disables only the Feishu Source.

Setup also checks every enabled named GitHub or Feishu Source instance with that instance's own `cli` and `repository`, or its bot `cli`, using the same probes. Such an instance's failure is recorded for that instance alone (`setup.problems` in `GET state` and the problem on its Source card and page); the deployment keeps running, and **Check again** runs the checks again. The default instance (`github`, `feishu`) needs no separate check because setup already reads its configuration. Setup does not keep a separate account per instance: the deployment's own GitHub account and Feishu bot stay the ones workers and replies use.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the agent's CLI, or says the installation has no GitHub account; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. With a GitHub account it selects the agent CLI as the github.com credential helper; without one it names no helper and says why. It rewrites GitHub SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat. For a local or remote folder, drop a file into the inbox: a local drop starts within 10 seconds (the seeded instance), a remote drop within its polling interval, and its reply appears as `<message id>.md` in the same folder's outbox or the remote outbox. For a web page/feed, publish a new item on the feed (or point the instance at a test feed): within matching `pollSeconds` it becomes a Ticket whose Thread is `web:<instance>:<item id>`, and its result is read in the panel — there is nothing written back to the feed.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained per scope: the installation default and each Source instance that saved its own. Parts without overrides follow the new defaults, and a Source that never saved a configuration follows the upgraded installation default. Overrides of removed parts, such as the old `skill/feishu` and `skill/github`, are dropped when that configuration is next saved. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| A named Source's card shows a setup problem while the deployment runs | That instance's own CLI or repository failed its check: fix it on that Source's page and choose **Check again**. Its sibling instances and the deployment keep working |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `gh is unavailable: this installation has no GitHub account.` | The GitHub Source names no repository; set one, `owner/name`, on the GitHub card to give workers a GitHub account |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the github.com credential configuration dsh-superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| A remote folder's card reports `Host key verification failed` | The known_hosts file names no key for that host and port, or its key changed: verify the host's fingerprint out of band and update the configured known_hosts file |
| A remote folder's card reports `Permission denied (publickey)` | The remote account does not accept the configured key: add the key's public half to its `authorized_keys`, and point `identityFile` at the matching private key |
| A remote folder's settings refuse `The identityFile cannot be read` | The key file path is relative, missing or unreadable by the dsh-superagent process; use an absolute path it can read |
| A web instance's settings refuse `must be an absolute http or https address` | The address is relative or uses another scheme; use the feed's full `https://…` or `http://…` address |
| A web instance's settings refuse `must not name a local or private address` | The address names `localhost`, a `.local` host or a private IP; publish the feed on a public address, or use a public tunnel/address |
| A web instance's card reports `resolves to … , a local or private address` | The host name currently resolves to a private address; point the instance at a host name that resolves only to public addresses |
| A web instance's card reports `redirected more than 3 times` or `redirected to an invalid location` | The feed redirects too often, or to an address the Source refuses; use the feed's final public address instead |
| A web instance's card reports `answered HTTP …` | The feed answered an error status; check the address in a browser and the feed's availability |
| A web instance's card reports `is larger than 2097152 bytes` | The feed or JSON document is over the 2 MiB body cap; publish a smaller document or a paged feed |
| A web instance's card reports `timed out after 20 s` | The feed did not answer within the request budget; check the address's reachability and latency |
| A web instance's card reports `is neither an RSS/Atom feed nor a JSON document` | `format` is `auto` and the answer cannot be read; set `format` explicitly or point the instance at a feed |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |
