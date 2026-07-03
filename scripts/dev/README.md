# Dev-only verification scripts

These scripts are for local audit and QA during development. They are **not**
published with the npm package (`package.json` `files` only includes `src/`, etc.)
and are **not** bundled into standalone binaries.

Run from the repository root:

```bash
node scripts/dev/audit-qa.mjs
node scripts/dev/doctor-split-qa.mjs
```
