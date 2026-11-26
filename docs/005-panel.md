# 005 Panel

Open **Superagent** in the DeepSeek Harness Web sidebar to supervise the agent. The panel prioritizes work that needs a person, then system health and history. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

## Three questions

Opening the panel answers three questions, in this order:

1. Does anything need me now?
2. Is the system healthy and doing the right things?
3. What is the history of one piece of work, from Trigger through Eval to Ticket?

## Tabs

The tabs follow the workflow: **Overview**, **Sources**, **Workstations**, **Artifacts** and **Settings**. A gear in the header opens **Settings** too, at the group it was left on. Until repository and account setup succeeds, Overview shows what is missing and links to the page that fixes it.

Policy and prompts are not top-level tabs: each Source instance owns its own, on a separate page reached from the **Policy and prompts** action on its card, on its page's header and on its account in **Settings → Sources**. That page has two tabs, **Policy** and **Prompts**. The latest Decisions keep a page of their own, reached from Overview, but take no tab. Other detail pages keep their routes too but take no tab: a Ticket, a Thread and the Execution list are opened from links (and the Overview's Executor block). A saved route reopens the same page after a refresh, including the old Trigger, Eval, Execution and Settings routes. An old Prompts route opens the Sources, and an old Policy route opens the Sources too, except its Eval section, which opens the Routing and Eval settings, and its Decisions, which keep the Decisions page.

| Page | Shows |
| --- | --- |
| Overview | Tickets needing action, recent artifacts, system problems, activity counts for the last 24 hours, and Executor load. Each block links to its detailed page; the accepted count opens the Decisions page |
| Sources | One card per Source instance: its state and switch, pending Tickets, the last 24 hours' arrivals, filtering, evaluations and acceptances, the Tickets' execution state (working, queued, waiting for a Trigger), and any requests still without a workstation. Each card carries its own instance's health, and the setup problem of a named GitHub or Feishu instance appears on that instance's card alone with **Check again**. A card offers **Open Source**, which opens the instance's own page with its Overview and Settings sections — its statistics, Tickets, filtered and unsent messages and recent Triggers, and its configuration with its history — and a separate **Policy and prompts** entry, which opens the instance's Policy and prompts page with its **Policy** and **Prompts** tabs. **Add Source** opens a two-step dialog: choose one of the eleven Source types, then an existing account of it (a disabled one is enabled) or a new account |
| Workstations | One card per Project: its name, its address kind (managed, folder or repository), its Sources, open Tickets, artifacts, latest activity and latest reporter. The built-in workspace comes first and is fixed: it cannot be archived or renamed. A card's six sections — Sources, Trigger, Eval, Execution, Settings and agent — open the project-level view, and a **Conversation** button beside them opens the Project's conversation in one click. **New workstation** creates a station, and **Show archived** lists the archived ones. On a Project's page, its artifact count opens the index filtered to that Project, and the page head's **Open conversation** button opens the same conversation |
| Artifacts | Delivered files newest collection first: name, Project, Source, Ticket, size and time, each with its download. Filters cover the Project (the workspace first) and Source instance, and a search matches a name or hash; the filters stay in the route. Each row opens the artifact's page, and a file that is no longer readable at its landing says so. Until a Ticket reports ready, the page explains that its delivered files will appear here |
| Recent decisions | The Decision log reached from Overview: each Decision shows its strength, reason, matched rules (named from its own Source's rules) and Policy version, filterable by kind (all work, accepted or continued, stopped, ignored, unavailable) and optionally to the last day. The filters stay in the route. It is not a top-level tab |
| Ticket, Thread, Execution | A Ticket's actions, authorization, waiting Inputs, Subscriptions, Assignments and artifacts; a Thread's timeline, Decisions and Subscriptions; and the Execution list filtered by Open, Pending, Working, Waiting for a Trigger or Ended, with the Executor state and **Pause processing** |
| Settings | Four groups: **Sources** (来源项 — the eleven Source types with their accounts: each account's settings, switch and delete, its Policy and prompts, and **Add account**), **Routing and Eval** (the Eval settings, and the history of Policy and Eval saves), **Executor and environment** (worker model, concurrency, directory root, prepare command, blocked commands) and **Deployment** (startup problems with **Check again**, the state directory and machine limits). Each group includes its save |

### Reading individual records

A dropped message links to its Ticket, or to its Thread when it has no Ticket. The Sources page explains whether its conversation disappeared or the Source stopped listening to it.

Each instance is responsible for its own state: two folder instances, or a default GitHub Source and a named one, show their own health, their own last day, their own allowed lists, rules and prompt configuration. A named GitHub or Feishu instance also has its own setup problem, which its card and page show with **Check again** while the rest of the deployment keeps running.

A request whose Project is not registered waits in Eval, and its Source card and page offer **Answer**: place it in an existing workstation, confirm the assessment's proposed one, or create a workstation from a name and a local folder or repository address. The request is then evaluated again and, once accepted, appears among that Source's Tickets. Adding an account takes effect on its next poll; a folder instance answers on the inbox it names.

### Adding a Source

**Add Source** on the Sources page works in two steps. First choose one of the twelve Source types; each entry gives its description, its account count and, for a type still being built, the 接入开发中 mark. Second, choose an existing account of that type, disabled ones included: choosing a disabled account enables it, and its card appears on the Sources page; an account that is already enabled says it is already in the Sources and offers to open its page. Alternatively create a new account — an optional key and label and the type's fields — which is created enabled. A placeholder type's account saves but receives and sends nothing yet. The dialog keeps the page's refresh and error reporting.

### Workstations

A Project's card leads with its address kind, its Sources, open Tickets and artifacts, then the six sections and the **Conversation** button. **Sources** lists every Source instance with its state and latest Trigger, and toggling one saves whether the Project names it: a named Source sends its drops to the Project by default. **Trigger** lists the Project's Threads and **Eval** the Decisions on them, each row opening the Thread page. **Execution** lists the Project's Tickets, newest first, and pages through them. **Settings** edits the name and aliases and shows the deliverables, working-copies and rules directories read-only, because a Project's directories are fixed when it is created; **Archive** hides it from the list by default and keeps its Tickets and artifacts, and **Restore** brings it back. **agent** edits the workstation agent's **requirements and rules** — the operator's persona and forced direction for this station, one editable entry each with add and remove and one save; the host trims entries and drops repetitions, and saving none clears them — and lists the history it collects: **Ticket history** with each Ticket's stage, outcome, reporter, Assignments and artifact count; **Change history (artifacts)** with each delivered file's name, Ticket, size, hash and time; and **Recent reports** with each Assignment report's Ticket, state and first two summary lines. The requirements enter the system prompt of the workstation's conversation and of its Tickets' executor Sessions when the list is not empty; a Ticket's executor reads a change on its next model request, while an open conversation reads it when it is next created or restored, because saving never restarts or wakes a Session. An empty list gives neither any text. The same section's **Workstation conversation** block states the fixed Session id (`project-<project id>`, created on the first click and opened afterwards) and offers **Open conversation**; the card's **Conversation** button and the page head's **Open conversation** button open it directly. The conversation works in the workstation's own directory — the station's folder, a repository's local checkout, or its working-copy directory — and never asks which workspace to use. The Ticket and artifact rows open their pages, and a Project with no Tickets yet says so.

The built-in workspace is where Tickets no station owns work; its card is marked **Fixed** and offers neither archiving nor renaming. A Project created from the panel takes its name's own slug as its key and refuses a name another Project already answers to, and its address is validated like an answer's: an absolute writable local folder outside the system directories, or a repository address of a supported protocol.

### Artifacts

The 产物 page indexes every delivered file. Each row names its file, the Project and Source it belongs to, the Ticket it was delivered for, its size and when it was collected, and downloads it; a file that has left its landing keeps its record and is marked as no longer readable. The Project dropdown starts with the workspace, the Source dropdown lists each instance, and the search matches a file's name or hash; all three stay in the route, so a filtered page survives a remount. A Project's artifact count links to the index already filtered to that Project.

An artifact's page shows its size, hash and collection time, the Project and Source behind it, the Ticket it was delivered for, and where it landed. Its delivery record says whether the file is still readable and names the result reply's message id; when the file is gone, the record stays and the download is disabled. The reverse chain runs **Artifact → Ticket → Assignment → worker Session**: it shows the Ticket's stage, state and reporter, the Assignment's state and latest report, and **Open Session** on the worker Session named after the Ticket, which opens it in DeepSeek Harness through the same Session check as every other Session link. **Download**, **Copy path**, **Open Ticket** and **Open Project** sit on the page.

A human follow-up still owned by an Executor is marked **Delivered to Ticket**, without an Eval. The Thread also shows hand-back reasons and context-only Subscriptions. **Evaluate again** can send that follow-up to Eval, or retry a Trigger with no effective judgement: one filtered by its Source, an unavailable Eval, or a delivered message with neither a non-stop Decision nor an Executor acknowledgement.

Ticket details show the originating Trigger, Decision and reason, scope and Policy version. A Ticket that delivered files lists them under **Artifacts**, each opening its artifact page and offering its download. Assignments and secondary details are folded below the immediate actions. **Retry** is available for failed Input delivery or a Ticket waiting for a person after a blocked or failed Report. Ended Tickets show outcomes such as **Pull request merged** or **Stopped by a person**.

## Settings

The header gear and the Settings tab open Settings where it was left; with no group left open, it opens **Sources**. Settings has four groups. A setting that belongs to one Source account is also on that account's own Source page; its Policy and prompts stay on its own Policy and prompts page.

- **Sources (工单源):** the twelve Source types — local folder, remote folder, web page/feed, GitHub, Gitee, WeChat, Feishu, DingTalk, QQ, Telegram, WeCom app and Email. The left list names each type with its account count; a type still being built is marked 接入开发中. The right side gives the selected type's description and its accounts. An account row shows its label and id, its state (enabled or disabled, and coming soon for a placeholder type), and a summary of its settings in which a credential is only marked as set. It offers **Edit settings** — the account's display name, followed by the type's fields, with a configuration history and one save bar, saved as that account's settings block. The display name is editable but must not repeat another account's; the configuration history reports a credential as set, replaced or cleared, never by value. The row also offers the enable switch, a confirmed delete that the host refuses while one of the account's Tickets is open, and, for an implemented type, its **Policy and prompts** page. **Add account** creates another account of the selected type. A placeholder type's account is saved but receives and sends nothing yet.
- **Routing and Eval:** the Eval settings — accept mode, the Eval timeout and the assessment model — and the history of Policy and Eval saves. A Ticket's Policy version opens this group, where the Policy history lists the saves.
- **Executor and environment:** worker model, concurrency, directory root, prepare command and blocked commands. Clicking an available variable inserts it into the prepare command.
- **Deployment:** startup problems with **Check again**, the state directory and machine limits. Saved limits apply without restart. The DeepSeek Harness Plugin Manager exposes the same page.

Each Source account's configuration is also on its own Source page, saved as that instance's settings block and followed by its configuration history. Its Policy and prompts page keeps the rules, identities, admission table and prompt configuration its Tickets read.

## A Source's Policy and prompts

An installed Source instance's page has two sections: **Overview** (its statistics, Tickets, filtered and unsent messages and recent Triggers) and **Settings** (its switch and its kind's configuration, with the configuration history). Its **Policy and prompts** (策略提示配置) page is separate: the card's and the page header's entries open it with two tabs, **Policy** and **Prompts**.

- **Policy:** the rules this instance's work is assessed by, the accept-rule list with add, duplicate, remove and enable switches, its allowed people, bots, membership sync and admission table, and the history of this instance's Policy saves. Until the instance saves its own rules, the rules shown are the installation's defaults and the panel says they are inherited; saving gives the instance a copy it owns. A rule change notifies only the Tickets this instance's rules bear on.- **Prompts:** the three team sections, the built-in parts, the skills and the version history of this instance's prompt configuration. The default skill of the instance's kind is listed read-only; team skills can be added beside it. An instance that never saved shows the installation's current configuration and history, marked inherited. The full prompt previews the assembled text; one save bar saves the whole configuration with conflict handling.

Edited built-in parts are marked changed and can be reset; templates list their required placeholders. An upgrade that changes an overridden default marks it **Default updated** (默认内容已更新). The panel compares the old and new defaults above the team's text. If the old default was not recorded, it compares the team's text with the new default instead. Choose **Keep my text** or **Use the new default**. Overrides for removed parts — such as the old `skill/feishu` and `skill/github` — are listed below the section bar and dropped on the next save. Restoring a version or the defaults creates another version; the history lists what each save changed.

The main Session's own prompt is the installation default, which is read by the main Session and inherited by Sources that have not saved theirs. It is not edited from the panel; the main Session itself changes it with `orchestrator_prompts_save` on an explicit human request.

## Recent decisions

The Decisions page shows what Eval decided, filterable by kind and optionally to the last day. Each Decision shows its strength, reason, matched rules and Policy version; a rule's name comes from the rules of the Decision's own Source, so a Source that renamed a rule reads correctly. The page has no tab: Overview's accepted count and other Decision links open it, and the filter stays in the route.

## Search

The header search finds Triggers by text, id, Feishu message id or a stored link, such as a GitHub comment URL. A Feishu link missing from the original message becomes searchable only after the host reads it during the current process lifetime.

Search also finds Threads by references such as `#12` or a GitHub URL, and Tickets by title or a matching Thread.

## Principles

1. **Focus on what matters.** Every element answers one of the three questions, or it is removed. A number appears only when it changes what the supervisor does.
2. **Precise definitions.** Categories have checkable definitions, are mutually exclusive and cover every case, as the Ticket stages do. A label says whom a row waits for and what it needs, not an internal status code.
3. **One place per concept.** Source state and configuration belong to the Source page, and its Policy and prompts to its own Policy and prompts page; Project cards and their six sections in Workstations; Threads and Triggers in Trigger; Tickets in Execution; the latest Decisions on their own page; Eval settings and the machine's settings in Settings. Overview summarizes these pages and links to them instead of becoming another detailed view.
4. **Domain structure.** The panel uses the domain terms. Internal identifiers appear only in folded details, and names replace identifiers where they can be resolved.
5. **Honest state.** A count equals the length of the list it links to, and no state contradicts another fact.
6. **Quiet by default.** Healthy states take no extra space. Problems must be actionable; a one-off network error is not enough. Rows needing a person offer their action directly. Keep page explanations to one sentence and put further detail in the (?) tooltip. Destructive actions require confirmation.
7. **Consistent controls.** Use DeepSeek Harness design tokens and control behavior. The same information should look the same throughout the panel. Each settings block has one save bar, visible only while changes exist, a save runs or a save fails.
