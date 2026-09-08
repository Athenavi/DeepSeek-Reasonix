# Desktop composer controls

[简体中文](COMPOSER_CONTROLS.zh-CN.md)

Use the **+** menu to attach content or enable Plan, Goal, or Delivery mode.
Normal execution and Standard delivery are the defaults. Active modes appear
as removable chips; removing Delivery restores Standard without changing Plan
or Goal. Approval policy remains a separate Ask/Auto/Yolo menu. Model and
reasoning effort have independent selectors; unsupported models hide effort.

The context ring opens usage details. **Turn time** excludes user-approval and
answer waits and stops at the controller's completion timestamp. Retry time
remains part of the turn. Turn tokens and throughput remain available during
waits, retries, and after completion; in-flight tokens are estimates. **Session
time** is the separately reported session aggregate. Starting a new turn resets
turn metrics. These live metrics are not a persisted historical report.

The composer defaults to 140px and preserves manual resizing. Running work
uses a theme-aware perimeter trace; reduced motion uses a static outline.
Approval, answer, and retry notices remain visible.

The bottom status bar combines workspace and branch into one item: it shows
the branch name, with both workspace path and branch in the tooltip. Non-Git
workspaces show the workspace name. Older item lists are deduplicated. On the
first upgrade, status labels default to icons; subsequent manual text/icon
choices are preserved. An older binary that rewrites preferences can remove
the upgrade marker, causing the icon default to apply again on re-upgrade.
