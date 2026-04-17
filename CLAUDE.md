# vlt-cli

## Release

Releases go through GitHub Actions. Do NOT manually bump versions or publish.

```bash
# 1. Push changes to main
git push origin main

# 2. Trigger release workflow
gh workflow run release.yml

# 3. Monitor until completion — do NOT return to user until done
RUN_ID=$(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status

# 4. If failed, check logs, fix, and re-release
gh run view "$RUN_ID" --log-failed

# 5. After success, update local binary
brew update && brew upgrade circlesac/tap/vlt
```

The workflow bumps CalVer via `@circlesac/oneup`, builds multi-platform binaries (darwin/linux/windows, x64+arm64), creates a GitHub release, publishes to npm, and updates the Homebrew tap.
