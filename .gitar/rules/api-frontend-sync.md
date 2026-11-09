---
title: API and frontend stay in sync
description: When an API response changes, check every place the frontend reads it
type: automation
when: "PRs that add, remove, rename or change the type of a field in a JSON response from any /api/ route in app/"
actions: "Add the 'api-change' label and comment with a table of each changed field and every frontend file and line that reads it. Request changes if the frontend still reads a removed or renamed field"
---

# API and frontend stay in sync

The server and the phone UI both live under `app/` and ship in the same image, so an API
change and the matching frontend change belong in the same PR.

For each response field that this PR adds, removes, renames or changes:

1. Find where the frontend reads it (`fetch` calls and the code that uses their results,
   including streamed answer events).
2. List the field, the change, and each place that reads it.
3. Flag any reader that still expects the old name, type or shape, and any new required
   field the frontend never renders.

If the PR changes no response shape, do not comment.
