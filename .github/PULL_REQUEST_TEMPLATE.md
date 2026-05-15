## Summary

<!-- 1-3 bullets: what changed and why. -->

## Type of change

- [ ] Bug fix (no API change)
- [ ] New feature (additive — opt-in or new export, no existing-behavior change)
- [ ] Breaking change (requires major version bump on affected packages)
- [ ] Docs / CI / tooling only

## Verification

- [ ] `pnpm -r build` clean
- [ ] `pnpm -r typecheck` clean
- [ ] `pnpm -r test` clean (note any flaky tests in the comment)
- [ ] If a plug-in: `runConformanceSuite()` passes (paste report below)

## Versioning

- [ ] `pnpm changeset` was run for any change to a published package
- [ ] N/A — internal-only change

## Notes for the reviewer
