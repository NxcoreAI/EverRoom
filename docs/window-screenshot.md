# Window Screenshots

> **已废弃（Phase 2/3 已移除）**：窗口截图采集（屏幕记忆上游）已在 Office + Agent 收敛重构（Phase 2/3）中整体移除；本文记录的是移除前的设计，仅作历史留存，不代表现行架构。现行范围见 `docs/office-agent-only-refactor-plan.zh-CN.md`。

EverOffice can capture only its current renderer window and save the JPEG locally.
It does not use `desktopCapturer`, so other applications and the rest of the
desktop are not included.

The Settings page exposes an immediate capture action and an opt-in recurring
capture scheduler. Enabling recurring capture takes one screenshot immediately,
then schedules the next capture after the configured interval. Captures never
overlap, and a failed capture is retried on the next interval.

During development, files are written to the repository root:

```text
screenshots/EverOffice-window-<UTC timestamp>-<UUID>.jpg
```

Packaged builds use the app's user-data directory instead, because an installed
application cannot safely write into its read-only bundle. Set
`NXCORE_SCREENSHOT_DIR` to override the directory in either mode.
