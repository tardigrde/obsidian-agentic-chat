# Project Workspaces

Project workspaces let you scope the agent to a subset of your vault, with dedicated model, style, and tool settings.

## What projects do

When a project is active, the agent behaves as if it has a narrower world:

- **Scoped folders** — Only notes inside the project folders are in the active working set. Requests outside the scope ask first.
- **Model override** — Use a different model id just for this project.
- **Output style** — Apply a different tone (default, brainstorm, learning).
- **System prompt overlay** — Append project-specific instructions to the system prompt.
- **Tool toggles** — Turn web or MCP on/off per project.
- **Scoped sessions** — Session history is separated by project; switching projects switches the active session set.

## Creating projects

Projects are configured in **Settings > Resources**. Each project needs:

- A name
- One or more vault folders (empty means all notes)
- Optional model id, profile, system prompt, and tool overrides

## Switching projects

Use `/project` in chat to open the project picker, or `/project <name>` to switch directly. `/project clear` returns to vault-wide mode.

The status bar shows the active project name and scope.

## When to use projects

- A large vault with unrelated areas (work, personal, research) where each area needs different conventions.
- A specific writing project that should use a cheaper or faster model.
- A sensitive folder that needs stricter tool boundaries.
