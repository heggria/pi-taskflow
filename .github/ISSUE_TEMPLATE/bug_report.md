---
name: Bug report
about: Report a problem with pi-taskflow
title: "[bug] "
labels: bug
assignees: heggria
---

**Describe the bug**
A clear and concise description of what's wrong.

**To reproduce**
Steps or the flow definition that triggers the bug:

```json
{
  "name": "minimal-repro",
  "phases": [...]
}
```

**Expected behavior**
What should have happened.

**Observed behavior**
What actually happened — error message, TUI output, or unexpected result.

**Environment**
- pi-taskflow version: `npm ls pi-taskflow` or `cat node_modules/pi-taskflow/package.json | grep version`
- Pi version: `pi --version`
- Node version: `node --version`
- OS: macOS / Linux / Windows

**Additional context**
- Run id (from `/tf runs` or `.pi/taskflows/runs/`): if applicable
- Does it reproduce on a fresh run (`/tf run <name>`)? yes / no

> **Response time:** I review bug reports ~weekly. Critical bugs (data loss, cache corruption, security) get priority.
