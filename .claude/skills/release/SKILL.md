---
name: release
description: Cut a launcher release — tag the current package.json version on main and push it, which triggers release.yml to build and publish the install tarball. Use when the user says to release, or to cut/tag/ship a version.
---

Cut a release from `main` (the tag must sit on merged main; `package.json` is the source of the version):

1. `git fetch`, then confirm the local branch is `main` and even with `origin/main`. If not, stop and tell the user.
2. Read `version` from `package.json`. If tag `v<version>` already exists (`git tag -l "v<version>"`), stop and tell the user to bump `package.json` first — never re-tag a shipped version.
3. Tag and push: `git tag -a "v<version>" -m "v<version>" && git push origin "v<version>"`. Then report the triggered run: `gh run list --workflow=release.yml -L 1`.
