# Release Checklist

Follow these steps every time a new version is released.

## Before coding

- [ ] All work is on a feature branch (never commit directly to `main`)

## Before committing

- [ ] `npm run build` passes with no errors
- [ ] `npm test` passes (all tests green)
- [ ] Manual smoke-test in Obsidian: open panel, run one learning session, check review works

## Versioning

Bump the version in **all three** files (or run `npm run bump <version>`):

| File | Field |
|------|-------|
| `package.json` | `"version"` |
| `manifest.json` | `"version"` |
| `versions.json` | add `"X.Y.Z": "0.15.0"` entry |

## Creating the release

1. Commit version bump: `git commit -m "chore: bump to X.Y.Z"`
2. Push the branch and open a PR
3. Merge the PR into `main`
4. Pull `main` locally: `git checkout main && git pull`
5. Tag the merge commit: `git tag X.Y.Z` (no `v` prefix)
6. Push the tag: `git push origin X.Y.Z`
7. GitHub Actions builds and publishes the release automatically

## After release

- [ ] Check the GitHub release page — confirm `main.js`, `manifest.json`, `styles.css`, `versions.json` are attached
- [ ] Install the new version in Obsidian and verify the plugin loads correctly
- [ ] Update `README.md` if any user-facing features changed
