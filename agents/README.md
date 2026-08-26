# EverRoom Agents

This directory contains the Agent bundles shipped with EverRoom. The Gateway
build copies it to `apps/gateway/dist/agents`, and EverRoom packages that
directory.

There are two bundle kinds:

- `kind: builtin` bundles are the definitions used by Gateway's built-in LLM
  entry points. Their manifests declare the capabilities, tools, and Skills
  that each runtime is allowed to receive. Pi runtimes load declared Skills
  read-only from the shipped bundle while keeping sessions and auth in an
  isolated writable runtime directory.
- `dispatch_only` bundles are developer-defined subagents. They are discovered
  by the subagent registry and can only be invoked through the main Agent's
  dispatch tools.

Create one directory per Agent:

```text
agents/
└── my-agent/
    ├── agent.yaml
    ├── SYSTEM.md
    ├── skills/
    └── schemas/
```

`NXCORE_SUBAGENTS_DIR` is only a development and test override. Built-in Agent
IDs listed in the architecture document are reserved and are not dispatchable
subagents.

`content-analyst` was the first developer-defined Agent. Its server integration
test proves that the default project directory is loaded through the same
Gateway startup path used by the desktop application. The shipped bundles also
include `multimodal-document-parser` and `context-room` (Context Room
enrichment, brief refresh, selection rewrite, and material analysis tasks).
