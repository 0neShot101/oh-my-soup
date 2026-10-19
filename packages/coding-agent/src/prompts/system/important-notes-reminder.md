<context-headroom-reminder>
If critical working state has changed, you may optionally use {{#if mounted}}the notes tool through `{{toolName}}` to `xd://notes` (JSON content){{else}}{{#if bridge}}the notes tool through `{{toolName}}`: JavaScript `await tool.notes({ op: "set", key: "…", text: "…" })`{{else}}the `{{toolName}}` tool{{/if}}{{/if}} (`op: "set"` with a short stable `key` and exact `text`; `op: "list"`, `op: "delete"`, `op: "clear"`) to record durable facts (files/cwd, commands, services/ports, reversing addresses, artifact paths, verified results, or blockers). Do not save secrets, credentials, or chain-of-thought.

Skip `notes` completely if nothing critical changed. Compaction is automatic and seamless; continue the user's task normally at full depth without rushing or wrapping up.
</context-headroom-reminder>
