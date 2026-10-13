# Release guide

## One-time repository settings

After creating the public GitHub repository:

1. Enable **Private vulnerability reporting** under Security settings.
2. Protect `main`: require the `CI` checks and at least one review when the
   project has additional maintainers.
3. Keep GitHub Actions workflow permissions read-only by default. The release
   workflow declares its own `contents: write` permission.
4. Add repository topics: `cursor`, `cursor-sdk`, `mcp`, `multi-agent`,
   `agent-orchestration`.

## Prepare a version

1. Update `package.json` and `.cursor-plugin/plugin.json` to the same version.
2. Move changelog entries from `Unreleased` to the release version and date.
3. Run:

```bash
npm ci
npm run verify
npm publish --dry-run
```

4. Commit the release preparation.

## Create the GitHub release

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin main
git push origin v0.1.0
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, verifies the project,
builds the npm tarball and attaches it to a generated GitHub Release.

## Publish to npm

The first npm publish is intentionally manual:

```bash
npm login
npm publish --access public
```

Before enabling automated npm publishing, configure npm Trusted Publishing for
this GitHub repository and add a dedicated workflow with `id-token: write`.
Do not store a long-lived npm token in the repository.
