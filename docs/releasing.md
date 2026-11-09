# Releasing

`lv24-opencode-consilium` is published to npm by GitHub Actions using
**Trusted Publishing (OIDC)**. There is no `NPM_TOKEN` secret and no manual
one-time password: npm validates the calling workflow and issues a short-lived
publish credential.

## One-time setup (per package)

The package owner runs this once, from a terminal, and completes the browser
2FA prompt:

```bash
npm trust github lv24-opencode-consilium \
  --file npm-publish.yml \
  --repo LevapVeeskela/lv24-opencode-consilium \
  --allow-publish -y
```

`npm trust list lv24-opencode-consilium` shows the configured relationship.
After this, only `.github/workflows/npm-publish.yml` on the default branch can
publish, and no OTP is needed.

## Regular release

1. Bump the version without committing a tag:

   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```

2. Update the version literals (the `version` test fails if one is missed):
   `src/domain/defaults.ts`, `src/infrastructure/config/generate.ts`,
   `src/interfaces/mcp/protocol.ts`, `consilium.config.example.json`,
   `llms.txt`, `.github/workflows/container.yml`, README/ru/zh (container tag,
   agent card, changelog) and the changelog entry.

3. Verify and push:

   ```bash
   npm test
   git add -A
   git commit -m "*[OC] - vX.Y.Z: ..."
   git push origin master
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. Create a GitHub release and publish it. Publishing the release triggers
   `.github/workflows/npm-publish.yml`, which builds, tests and publishes the
   version with provenance. Already-published versions are skipped.

5. Manual fallback:

   ```bash
   gh workflow run npm-publish.yml -f version=X.Y.Z
   ```

6. Container image (manual, GHCR):

   ```bash
   gh workflow run container.yml -f version=X.Y.Z
   ```

7. Verify:

   ```bash
   npm view lv24-opencode-consilium version
   docker run --rm ghcr.io/levapveeskela/lv24-opencode-consilium:X.Y.Z --version
   ```
