import { describe, expect, it } from "vitest"

import { reduceAcpToolCallUpdate, type AcpToolCallState } from "../src/modules/local-agents/acp-runtime.js"

const bashCall = {
  sessionUpdate: "tool_call" as const,
  toolCallId: "tc-1",
  title: "Bash(git status)",
  kind: "execute",
  status: "pending",
  rawInput: { command: "git status" },
}

function stateOf(update: ReturnType<typeof reduceAcpToolCallUpdate>): AcpToolCallState {
  return update.next
}

describe("reduceAcpToolCallUpdate", () => {
  it("maps a pending tool_call to tool.requested with shell semantics", () => {
    const { events, next } = reduceAcpToolCallUpdate(undefined, bashCall)
    expect(events).toEqual([
      { type: "tool.requested", payload: { toolCallId: "tc-1", name: "shell", args: { command: "git status" }, title: "Bash(git status)" } },
    ])
    expect(next).toMatchObject({ name: "shell", status: "pending", terminal: false })
  })

  it("progresses requested → started on in_progress and emits terminal completed once", () => {
    const first = reduceAcpToolCallUpdate(undefined, bashCall)
    const started = reduceAcpToolCallUpdate(stateOf(first), {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "in_progress",
    })
    expect(started.events.map((event) => event.type)).toEqual(["tool.started"])

    const done = reduceAcpToolCallUpdate(stateOf(started), {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
      rawOutput: { stdout: "nothing to commit" },
    })
    expect(done.events).toEqual([
      { type: "tool.completed", payload: { toolCallId: "tc-1", name: "shell", result: { stdout: "nothing to commit" } } },
    ])
    expect(done.next.terminal).toBe(true)

    const replay = reduceAcpToolCallUpdate(stateOf(done), {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
      rawOutput: { stdout: "nothing to commit" },
    })
    expect(replay.events).toEqual([])
  })

  it("maps failures to tool.failed with the adapter title as message", () => {
    const first = reduceAcpToolCallUpdate(undefined, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-2",
      title: "Bash(rm -rf /)",
      kind: "execute",
    })
    expect(first.events.map((event) => event.type)).toEqual(["tool.requested"])
    const failed = reduceAcpToolCallUpdate(stateOf(first), {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-2",
      status: "failed",
    })
    expect(failed.events).toEqual([
      { type: "tool.failed", payload: { toolCallId: "tc-2", name: "shell", message: "Bash(rm -rf /)" } },
    ])
  })

  it("emits tool.updated when rawInput grows but keeps the kind-derived name", () => {
    const first = reduceAcpToolCallUpdate(undefined, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-3",
      title: "Edit src/app.ts",
      kind: "edit",
      status: "in_progress",
      rawInput: { file_path: "/w/src/app.ts" },
    })
    expect(first.events.map((event) => event.type)).toEqual(["tool.started"])
    const grown = reduceAcpToolCallUpdate(stateOf(first), {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-3",
      rawInput: { file_path: "/w/src/app.ts", new_string: "export const x = 2" },
    })
    expect(grown.events).toEqual([
      {
        type: "tool.updated",
        payload: {
          toolCallId: "tc-3",
          name: "edit",
          args: { file_path: "/w/src/app.ts", new_string: "export const x = 2" },
          title: "Edit src/app.ts",
        },
      },
    ])
  })

  it("falls back to tool.started when the first sighting is already terminal", () => {
    const { events, next } = reduceAcpToolCallUpdate(undefined, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-4",
      title: "Grep(todo)",
      kind: "search",
      status: "completed",
    })
    expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.completed"])
    expect(events[1]!.payload).toMatchObject({ toolCallId: "tc-4", name: "search", result: "Grep(todo)" })
    expect(next.terminal).toBe(true)
  })
})
