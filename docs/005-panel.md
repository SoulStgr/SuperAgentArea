# 005 Panel

Open **Superagent** in the DeepSeek Harness Web sidebar to supervise the agent. The panel prioritizes work that needs a person, then system health and history. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

## Three questions

Opening the panel answers three questions, in this order:

1. Does anything need me now?
2. Is the system healthy and doing the right things?
3. What is the history of one piece of work, from Trigger through Eval to Ticket?

## Tabs

The tabs follow the workflow: **Overview**, **Sources**, **Workstations**, **Artifacts**, **Prompts**, and **Policy & Eval**. A gear in the header opens **Settings**. Until repository and account setup succeeds, Overview shows what is missing and links to the page that fixes it.

Detail pages keep their own routes but take no tab: a Ticket, a Thread, and the Execution list are opened from links (and the Overview's Executor block), and Settings from the header gear. A saved route reopens the same page after a refresh, including the old Trigger, Eval, Execution and Settings routes.

| Page | Shows |
| --- | --- |
| Overview | Tickets needing action, recent artifacts, system problems, activity counts for the last 24 hours, and Executor load. Each block links to its detailed page |
| Sources | One card per Source instance: its state and switch, pending Tickets, the last 24 hours' arrivals, filtering, evaluations and acceptances, the Tickets' execution state (working, queued, waiting for a Trigger), and any requests still without a workstation. Each card carries its own instance's health, and the setup problem of a named GitHub or Feishu instance appears on that instance's card alone with **Check again**. **Add Source** creates a named instance of an installed kind. A card opens the instance's own page with its configuration, statistics, Tickets, filtered and unsent messages, recent Triggers, and its configuration history |
| Workstations | One card per Project: its name, its address kind (managed, folder or repository), its Sources, open Tickets, artifacts, latest activity and latest reporter. The built-in workspace comes first and is fixed: it cannot be archived or renamed. A card's six sections — Sources, Trigger, Eval, Execution, Settings and agent — open the project-level view; the agent section opens the Project's Session and the history it collects. **New workstation** creates a station, and **Show archived** lists the archived ones. On a Project's page, its artifact count opens the index filtered to that Project |
| Artifacts | Delivered files newest collection first: name, Project, Source, Ticket, size and time, each with its download. Filters cover the Project (the workspace first) and Source instance, and a search matches a name or hash; the filters stay in the route. Each row opens the artifact's page, and a file that is no longer readable at its landing says so. Until a Ticket reports ready, the page explains that its delivered files will appear here |
| Prompts | **Edit**, **Full prompt** and **History** as page sections: edit team sections, built-in parts and skills; read the assembled prompt and compare it with the saved text or defaults; list and restore versions. Saving uses one save bar with conflict handling |
| Policy & Eval | Three page sections: **Rules and admission** (the Policy version, accept rules, each Source's Policy part and admission table, with configuration history), **Eval settings** (accept mode, timeout and assessment model), and **Recent decisions** (the Decision log with strength, reason and Policy version, filterable by kind and to the last day) |
| Ticket, Thread, Execution | A Ticket's actions, authorization, waiting Inputs, Subscriptions, Assignments and artifacts; a Thread's timeline, Decisions and Subscriptions; and the Execution list filtered by Open, Pending, Working, Waiting for a Trigger or Ended, with the Executor state and **Pause processing** |
| Settings (gear) | **Executor and environment** (worker model, concurrency, directory root, prepare command, blocked commands) and **Deployment** (startup problems with **Check again**, the state directory and machine limits). Each group includes its save |

### Reading individual records

A dropped message links to its Ticket, or to its Thread when it has no Ticket. The Sources page explains whether its conversation disappeared or the Source stopped listening to it.

Each instance is responsible for its own state: two folder instances, or a default GitHub Source and a named one, show their own health and their own last day. A named GitHub or Feishu instance also has its own setup problem, which its card and page show with **Check again** while the rest of the deployment keeps running.

A request whose Project is not registered waits in Eval, and its Source card and page offer **Answer**: place it in an existing workstation, confirm the assessment's proposed one, or create a workstation from a name and a local folder or repository address. The request is then evaluated again and, once accepted, appears among that Source's Tickets. Adding a Source of an installed kind takes effect on its next poll; a folder instance answers on the inbox it names.

### Workstations

A Project's card leads with its address kind, its Sources, open Tickets and artifacts, then the six sections. **Sources** lists every Source instance with its state and latest Trigger, and toggling one saves whether the Project names it: a named Source sends its drops to the Project by default. **Trigger** lists the Project's Threads and **Eval** the Decisions on them, each row opening the Thread page. **Execution** lists the Project's Tickets, newest first, and pages through them. **Settings** edits the name and aliases and shows the deliverables, working-copies and rules directories read-only, because a Project's directories are fixed when it is created; **Archive** hides it from the list by default and keeps its Tickets and artifacts, and **Restore** brings it back. **agent** opens the Project's Session in its working-copy directory — the first click creates it under the fixed id `project-<project id>`, later clicks open the same Session — and lists the history it collects: **Ticket history** with each Ticket's stage, outcome, reporter, Assignments and artifact count; **Change history (artifacts)** with each delivered file's name, Ticket, size, hash and time; and **Recent reports** with each Assignment report's Ticket, state and first two summary lines. The Ticket and artifact rows open their pages, and a Project with no Tickets yet says so.

The built-in workspace is where Tickets no station owns work; its card is marked **Fixed** and offers neither archiving nor renaming. A Project created from the panel takes its name's own slug as its key and refuses a name another Project already answers to, and its address is validated like an answer's: an absolute writable local folder outside the system directories, or a repository address of a supported protocol.

### Artifacts

The 产物 page indexes every delivered file. Each row names its file, the Project and Source it belongs to, the Ticket it was delivered for, its size and when it was collected, and downloads it; a file that has left its landing keeps its record and is marked as no longer readable. The Project dropdown starts with the workspace, the Source dropdown lists each instance, and the search matches a file's name or hash; all three stay in the route, so a filtered page survives a remount. A Project's artifact count links to the index already filtered to that Project.

An artifact's page shows its size, hash and collection time, the Project and Source behind it, the Ticket it was delivered for, and where it landed. Its delivery record says whether the file is still readable and names the result reply's message id; when the file is gone, the record stays and the download is disabled. The reverse chain runs **Artifact → Ticket → Assignment → worker Session**: it shows the Ticket's stage, state and reporter, the Assignment's state and latest report, and **Open Session** on the worker Session named after the Ticket, which opens it in DeepSeek Harness through the same Session check as every other Session link. **Download**, **Copy path**, **Open Ticket** and **Open Project** sit on the page.

A human follow-up still owned by an Executor is marked **Delivered to Ticket**, without an Eval. The Thread also shows hand-back reasons and context-only Subscriptions. **Evaluate again** can send that follow-up to Eval, or retry a Trigger with no effective judgement: one filtered by its Source, an unavailable Eval, or a delivered message with neither a non-stop Decision nor an Executor acknowledgement.

Ticket details show the originating Trigger, Decision and reason, scope and Policy version. A Ticket that delivered files lists them under **Artifacts**, each opening its artifact page and offering its download. Assignments and secondary details are folded below the immediate actions. **Retry** is available for failed Input delivery or a Ticket waiting for a person after a blocked or failed Report. Ended Tickets show outcomes such as **Pull request merged** or **Stopped by a person**.

## Settings

The header gear opens Settings where it was left. Settings has two groups; the settings that belong to a Source, to Eval or to the prompts live on their own pages.

- **Executor and environment:** worker model, concurrency, directory root, prepare command and blocked commands. Clicking an available variable inserts it into the prepare command.
- **Deployment:** startup problems with **Check again**, the state directory and machine limits. Saved limits apply without restart. The DeepSeek Harness Plugin Manager exposes the same page.

Each Source instance's configuration is on its own Source page, saved as that instance's settings block and followed by its configuration history. The Policy page holds the accept rules, admission, Eval settings and recent Decisions; a Ticket's Policy version opens its save in the Policy history.

## Prompts

The Prompts page edits the team prompt configuration:

- **Edit** changes team sections, built-in parts and skills.
- **Full prompt** shows the assembled text and compares it with saved text or defaults.
- **History** lists versions.

Edited built-in parts are marked changed and can be reset; templates list their required placeholders. An upgrade that changes an overridden default marks it **Default updated** (默认内容已更新). The panel compares the old and new defaults above the team's text. If the old default was not recorded, it compares the team's text with the new default instead. Choose **Keep my text** or **Use the new default**. Overrides for removed parts are listed below the section bar and dropped on the next save.

## Policy & Eval

The Policy page combines what Eval follows and what it decided, as three sections instead of stacked tabs:

- **Rules and admission:** the Policy version and its explanation, the accept rules with their enable switches, each Source's allowed people, bots, membership sync and admission table, and the configuration history. Each Source's part uses that Source's own identities, with no mapping between Sources.
- **Eval settings:** the accept mode, the Eval timeout and the assessment model.
- **Recent decisions:** the Decision log, filtered by kind (all work, accepted or continued, stopped, ignored, unavailable) and optionally to the last day. Each Decision shows its strength, reason, matched rules and Policy version.

Saving a rule or admission change saves the Policy block; saving an Eval setting saves the Eval block. Each save uses its own revision and the same save bar as Settings.

## Search

The header search finds Triggers by text, id, Feishu message id or a stored link, such as a GitHub comment URL. A Feishu link missing from the original message becomes searchable only after the host reads it during the current process lifetime.

Search also finds Threads by references such as `#12` or a GitHub URL, and Tickets by title or a matching Thread.

## Principles

1. **Focus on what matters.** Every element answers one of the three questions, or it is removed. A number appears only when it changes what the supervisor does.
2. **Precise definitions.** Categories have checkable definitions, are mutually exclusive and cover every case, as the Ticket stages do. A label says whom a row waits for and what it needs, not an internal status code.
3. **One place per concept.** Source state and configuration belong to Sources; Project cards and their six sections in Workstations; Threads and Triggers in Trigger; Decisions in Policy & Eval; Tickets in Execution; prompts in Prompts; the machine's settings in Settings. Overview summarizes these pages and links to them instead of becoming another detailed view.
4. **Domain structure.** The panel uses the domain terms. Internal identifiers appear only in folded details, and names replace identifiers where they can be resolved.
5. **Honest state.** A count equals the length of the list it links to, and no state contradicts another fact.
6. **Quiet by default.** Healthy states take no extra space. Problems must be actionable; a one-off network error is not enough. Rows needing a person offer their action directly. Keep page explanations to one sentence and put further detail in the (?) tooltip. Destructive actions require confirmation.
7. **Consistent controls.** Use DeepSeek Harness design tokens and control behavior. The same information should look the same throughout the panel. Each settings block has one save bar, visible only while changes exist, a save runs or a save fails.
