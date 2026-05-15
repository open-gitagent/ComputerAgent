---
"computeragent": minor
"create-computeragent": patch
---

Add the `computeragent` umbrella package as the one-line entry point.

`npm install computeragent` now installs the SDK + `LocalSubstrate` in a
single dependency. The 13 scoped `@computeragent/*` packages remain
independently publishable for power users who want minimal deps. Same
pattern as `next` (umbrella) + `@next/*` (parts).

The `create-computeragent` scaffold now generates a `package.json` with
`computeragent` as its only dependency, and `index.ts` imports from
`"computeragent"` instead of two scoped packages.
