# pi-subagents

A minimal pi extension that adds a single `subagent` tool for delegating work to isolated child pi processes, plus two bundled subagent prompts:

- **scout** — fast read-only codebase recon (locked to `gpt-6-luna`)
- **general-purpose** — deep coding work, multi-file refactors, architecture questions (default `gpt-6.1-sol:high`, overridable per call)

Recursion is capped at depth 2 — anything a subagent spawns is leaf-only.

This repository is auto-synced from [`Agentic-developers/adw`](https://github.com/Agentic-developers/adw) (`packages/pi_extensions/` + `.pi/agents/`). Do not edit files here directly; changes will be overwritten on the next sync.

## Install

```bash
pi install git:github.com/Agentic-developers/pi-subagents
```

Pin to a commit with `@<sha>`.

To try without installing:

```bash
pi -e git:github.com/Agentic-developers/pi-subagents
```

## Usage

Once installed, the `subagent` tool is available to your pi agent. From inside pi, ask it to delegate:

> "Use the scout subagent to find where session resumption is handled."

> "Spawn a general-purpose subagent at `gpt-6-luna:high` to refactor the auth middleware."

The tool accepts:

- `agent` (required) — `scout` or `general-purpose`
- `task` (required) — task description for the subagent
- `model` (optional) — override the agent's pinned model (e.g. `gpt-6-sol`, `gpt-6.1-sol:high`)
- `thinking` (optional) — override reasoning effort (`off` | `minimal` | `low` | `medium` | `high` | `xhigh`)

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `ADW_PI_AGENTS_DIR` | `<package>/agents` | Where to load subagent `.md` files from. The default resolves to this package's bundled `agents/` directory. |
| `ADW_PI_DEFAULT_SUBAGENT_MODEL` | `gpt-6-luna` | Fallback model when neither the call nor the agent frontmatter specifies one. |
| `ADW_PI_PROVIDER` | `openai` | Provider passed to the child pi process. |
| `ADW_PI_BIN` | `pi` | Path to the pi binary (override if not on PATH). |

## License

MIT — see LICENSE.
