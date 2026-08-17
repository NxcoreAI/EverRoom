# Window Screenshots

EverRoom can capture only its current renderer window and save the JPEG locally.
It does not use `desktopCapturer`, so other applications and the rest of the
desktop are not included.

The Settings page exposes an immediate capture action and an opt-in recurring
capture scheduler. Enabling recurring capture takes one screenshot immediately,
then schedules the next capture after the configured interval. Captures never
overlap, and a failed capture is retried on the next interval.

During development, files are written to the repository root:

```text
screenshots/EverRoom-window-<UTC timestamp>-<UUID>.jpg
```

Packaged builds use the app's user-data directory instead, because an installed
application cannot safely write into its read-only bundle. Set
`NXCORE_SCREENSHOT_DIR` to override the directory in either mode.
