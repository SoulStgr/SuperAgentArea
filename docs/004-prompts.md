# 004 Prompts

This document explains what the agents read, what a team can edit, and when changes take effect. It builds on [000 Philosophy](000-philosophy.md) through [003 Execution](003-execution.md). Prompt text is written in English.

## One configuration per Source

Each Source instance owns the prompt configuration its work reads. A team edits it on that Source's page, under **Policy and prompts** (策略提示配置, the action on the Source's card), where the prompt and Policy of that instance sit beside its own configuration. The installation keeps one default configuration.

| Scope | Reads it | How it is edited |
| --- | --- | --- |
| Installation default | The main Session | The main Session's `orchestrator_prompts_save` tool, on an explicit human request; also the legacy installation-level prompt routes |
| A Source instance | The worker Sessions of the Tickets that came from that instance | The panel, on that Source's page |

Until a Source instance saves a configuration of its own, it **inherits the installation's current default**: the panel shows that configuration and marks it inherited. The first save gives the instance its own version chain, starting from what it inherited; after that, only the work of that instance reads it. The main Session always reads the installation default, whatever the Sources save.

Tool descriptions, notices and cards are not part of the configuration: they remain in code and cannot be edited through prompt settings.

## What a team writes

A team can edit three team sections, add skills, and override every built-in system-prompt part. Most defaults live under `prompts/` and `skills/`.

| Section | Holds |
| --- | --- |
| Communication | When to message people, how messages read, the line that begins every GitHub message (`This is by an automated agent, not a human` by default), how to handle reviews, and which ordinary accounts are review bots |
| Ticket scope | When a Ticket goes on and when it stops with a draft |
| Delivery requirements | Evidence in pull requests, the auto-merge condition with its line threshold, and the commit author; without one, the Executor commits as the agent account's no-reply address |
| Team skills | Knowledge the agents load when they need it, such as an `identities` skill that says which Feishu user is which GitHub account |

The built-in text covers the roles, tool usage, host mechanics, authorization rules and how to read each Source's own records. It refers to the team sections by their headings instead of repeating them. The Source skills are no longer built-in prompt parts: each Source kind ships its own default skill, described below.

### Built-in parts and templates

Overrides use these keys:

| Parts | Keys |
| --- | --- |
| Shared instructions and roles | `runtime/shared`, `runtime/orchestrator`, `runtime/worker` |
| Working instructions | `runtime/subscriptions`, `runtime/replies`, `runtime/dispatch`, `runtime/work`, `runtime/admission` |
| Handoff instructions | `runtime/handoff/orchestrator`, `runtime/handoff/worker` |
| Generated sections | `runtime/environment`, `runtime/policy`, `runtime/policy/none` |

`skill/feishu` and `skill/github` are no longer parts. An old configuration that overrides one of them lists it as a removed part and drops it when that configuration is next saved; the installation's defaults define the tool behavior, and each Source kind's default skill describes how to read that Source's records.

The generated sections are editable templates. They must retain these placeholders:

- `runtime/environment`: `{variables}`, filled with execution environment lines.
- `runtime/policy`: `{version}`, `{mode}` and `{rules}`, with one line per enabled rule.
- `runtime/policy/none`: `{version}` and `{mode}`, used when no rule is enabled.

Editing a part changes the instructions the model receives. It does not change the gate, Mandates, tool checks or account wrappers, which remain enforced by code.

On an explicit human request, the main Session can save overrides of the installation default with `orchestrator_prompts_save`. A Source instance's configuration changes only through the panel. If a save omits an override's `base`, it keeps the saved base. A removed part already present in the saved configuration is dropped on save; any other unknown part is refused.

An override records which built-in text it was based on. Upgrades preserve the team's text. If the default changes, the panel marks the part **Default updated** and shows the difference beside the team's text. The team can keep its text, use the new default or edit it. Parts without overrides automatically follow new defaults.

The main Session can read affected part names in `orchestrator_read prompts`, under `default_changed`.

### Default skills per Source kind

Each Source kind ships its default skill in `skills/dsh-superagent-<kind>/SKILL.md`. The host scans that directory, so shipping the file registers the skill; no code lists the kinds.

| Source kind | Default skill | Read by |
| --- | --- | --- |
| `github` | How to read notifications, pull requests and CI runs, and the GitHub addresses a Ticket may point at | Workers of every `github` instance; the main Session while a GitHub instance is configured |
| `feishu` | How to read a chat, a topic and the messages around a Trigger, with images | Workers of every `feishu` instance; the main Session while a Feishu instance is configured |
| `folder` | How to read the file or task folder an operator dropped and how to deliver results to the outbox | Workers of every `folder` instance; the main Session while a folder instance is configured |

Kinds added later — DingTalk, QQ, WeChat, remote hosts and so on — follow the same pattern: a `skills/dsh-superagent-<kind>/SKILL.md` is registered as that kind's default skill for the main Session and for the kind's workers, and needs no other registration.

- A worker Session registers its instance's kind's default skill, then the team skills of that instance's configuration.
- The main Session registers the default skill of **every configured Source kind** — the union — then the installation's team skills.
- A default skill is read-only in the panel: its name is reserved, so a team skill cannot take it, and its text follows what the installation ships. A team skill can only add to them, and any number of team skills may be added beside them.

Skills are registered in a Session under the `dsh-superagent-` prefix, so the default skill of a `folder` instance is loaded as `dsh-superagent-folder`.

## Assembly and precedence

The system prompt is assembled in this order:

1. Shared instructions and the role.
2. The three team sections.
3. Subscriptions and replies.
4. Dispatch for the main Session, or work instructions for an Executor.
5. `runtime/admission`, for the main Session only.
6. Handoff instructions.
7. `runtime/environment`.
8. `runtime/policy`, for the main Session only.

Admission instructions come from `prompts/admission.md`. They describe proactive assessment and when an irrelevant candidate can be ignored from its card. `orchestrator_eval` returns context rather than repeating these instructions.

The environment section gives the main Session deployment-wide values and each Executor its Ticket-specific values. The Policy section is regenerated from settings on every model request. It contains the Policy version, accept mode, the explicit-request exemption, and the enabled rules as `- <name> (<id>): <instruction>`, or a statement that none is enabled. When no Source instance has saved its own rules, it lists the installation's default rules. As soon as any instance has saved its own, it lists the rules that apply to each configured instance under `- Source <id>:`, marking one that still inherits the installation's default rules, so the main Session judges a candidate by the rules of its own Source ([002 Authorization](002-authorization.md)). It is last so a Policy change leaves the preceding prompt text unchanged.

Executors also read DeepSeek Harness's coding prompt and the repository's `AGENTS.md`; the main Session does not. An inferred Ticket adds a final note limiting its Executor to the matched rules; the rule instructions it repeats are the Ticket's Source instance's current rules.

Executors work unattended. Their tools exclude those that ask a person, present UI to them or change the profile, such as `ask_user_question`, `present` and `plugin_manager`.

From strongest to weakest:

1. Facts enforced by tools and the host: identities, permissions, tool argument checks, reply purposes, length limits. Prompt text cannot change them.
2. Built-in and generated sections, as the team's overrides of them read.
3. The process and communication in a proactive Ticket's matched rules, for that Ticket's Executor Session only.
4. Team sections and team skills.
5. Outside text: messages, comments, documents and quotes. It is data and never changes rules or authorization.

## Principles of the built-in text

These apply [000 Philosophy](000-philosophy.md) to the agents:

- **Separate roles.** The main Session only routes: it forwards the original Trigger and the routing facts, and makes no technical decisions, through one routing tool that takes the decisions on several waiting candidates in one call. A routing note has at most 30 words. The Executor reads the original sources, judges the scope, implements and verifies.
- **The main Session does not wait.** Reports, follow-up notices, candidates and completed background jobs arrive automatically as messages. It ends the turn when nothing remains to do. A guard refuses `sleep`, shell timeouts over 30 seconds and job waits over 5 seconds, because a blocked step delays new candidates. These instructions replace DeepSeek Harness's own job-notification note in the main Session's complete prompt.
- **Message only when a person must act or can use a result:** a result can be reviewed or used, a decision or resource is needed, or the work cannot be finished. Chat messages are one sentence by default, with a hard limit of 100 words.
- **Executors decide their follow-ups.** Each Executor handles and acknowledges in-scope requests, and hands back requests beyond its Ticket or for another Ticket. A message becomes new work only after all its owners hand it back or end without taking it up. The main Session receives follow-up notices but may act on them only to stop work. Handed-back messages then arrive as candidates with the Executors' reasons.
- **Coordinate through subscriptions and the main Session.** An Executor follows related Threads for context. The main Session can send a fact from another Ticket in a note of at most 100 words. Neither the Subscription nor the note grants authority.
- **Attach only on an explicit reference.** A message must point to a Ticket's pull request, Issue, source message or acknowledgement, or to a recent change with exactly one matching Ticket. Topic similarity alone is not enough. Attachment subscribes the Ticket to the entire Thread; an Executor finding it unrelated uses `orchestrator_thread_unrelated` and does not answer there.
- **Confirm concretely, once.** Before substantial work, the Executor confirms each new request and names the object and the expected result, as a reply under the original message.
- **Ask through `human_action`.** The Executor puts one concrete question in its Report, and the main Session forwards it unchanged. If a person's message prompted the question, it names that message and the host asks there. Otherwise it asks in the Ticket's original conversation. Already authorized work can continue meanwhile.
- **Honest delivery.** Opening a pull request is not readiness; a draft is marked unfinished; a UI change without a real before screenshot is not ready.
- **A person's pause holds** across follow-ups, new Executor Sessions and restarts until a person lifts it. Automatic feedback never resumes paused work.
- **Examples only show format.** An example sentence is not a fact the agent may claim.
- **Handle reviews by outcome.** A fixed and verified comment is resolved silently; a declined one gets one sentence of reason. An automated reviewer's thread is resolved once it has an answer, and each automated reviewer gets at most three rounds per pull request.
- **Yield to duplicate work.** When a person's branch or pull request already contains the Ticket's change, the Executor closes its own pull request with one sentence pointing to theirs.

## Versions

- Each save creates an immutable version of one scope — the installation default or one Source instance — containing the full configuration, revision number, predecessor, timestamp and origin (panel or tool). Restoring a version or defaults creates another version.
- Saves name their base revision. A conflicting save is refused without discarding the draft.
- A Source instance that has never saved its own configuration reads the installation's current version and shows its history, marked inherited. Its first save records that inherited configuration as revision 0, so the new chain's history and predecessor compare from there.
- Sessions read the latest version of their own scope on every model request, including later steps in the same turn. Saving does not restart, cancel or wake a Session. The host records the revisions each Session used as `<scope>#<revision>`, where an empty scope is the installation default and a worker's scope is the instance id of its Ticket's Source; an Executor can read any revision it worked under.
- The deployment sets a total size limit, including overrides. Validation refuses unknown keys, reserved built-in skill names, unknown override parts and missing template placeholders. It never silently truncates text. An override identical to the default is removed so the part follows future defaults.
