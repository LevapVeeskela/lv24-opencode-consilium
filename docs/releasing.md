# Releasing

`lv24-opencode-consilium` is published to npm and PyPI by GitHub Actions using
**Trusted Publishing (OIDC)**. There are no tokens or one-time passwords: npm
and PyPI validate the calling workflow and issue short-lived publish
credentials.

- npm: `.github/workflows/npm-publish.yml`
- PyPI: `.github/workflows/pypi-publish.yml` (thin Python launcher; setup in
  [`docs/pypi.md`](pypi.md))

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

For PyPI, add a pending trusted publisher once (PyPI account with 2FA, project
`lv24-opencode-consilium`, owner `LevapVeeskela`, repository
`lv24-opencode-consilium`, workflow `pypi-publish.yml`, environment blank). The
first release creates the project. Details: [`docs/pypi.md`](pypi.md).

## Regular release

1. Bump the version without committing a tag:

   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```

2. Update the version literals (the `version` test fails if one is missed):
   `src/domain/defaults.ts`, `src/infrastructure/config/generate.ts`,
   `src/interfaces/mcp/protocol.ts`, `consilium.config.example.json`,
   `llms.txt`, `.github/workflows/container.yml`, `python/pyproject.toml`,
   `python/src/lv24_opencode_consilium/__init__.py`, README/ru/zh (container
   tag, agent card, changelog) and the changelog entry.

3. Verify and push:

   ```bash
   npm test
   python -m unittest discover -s python/tests
   git add -A
   git commit -m "*[OC] - vX.Y.Z: ..."
   git push origin master
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. Create a GitHub release and publish it. Publishing the release triggers
   `.github/workflows/npm-publish.yml` and `.github/workflows/pypi-publish.yml`,
   which build, test and publish the same version with provenance / OIDC.
   Already-published versions are skipped.

   > The release event runs the workflows from the tagged commit, so both
   > workflow files must already exist at that tag. Tag releases created after
   > the workflows were merged; for older tags, use the manual dispatch below.

5. Manual fallback:

   ```bash
   gh workflow run npm-publish.yml -f version=X.Y.Z
   gh workflow run pypi-publish.yml -f version=X.Y.Z
   ```

6. Container image (manual, GHCR):

   ```bash
   gh workflow run container.yml -f version=X.Y.Z
   ```

7. Verify:

   ```bash
   npm view lv24-opencode-consilium version
   pip index versions lv24-opencode-consilium
   docker run --rm ghcr.io/levapveeskela/lv24-opencode-consilium:X.Y.Z --version
   ```
