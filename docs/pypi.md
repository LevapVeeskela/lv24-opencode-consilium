# PyPI publishing

`lv24-opencode-consilium` is published on PyPI as a small Python wrapper around
the canonical npm CLI. `pip install lv24-opencode-consilium` installs the
`consilium` console script, which delegates to the npm package through `npx`.
The council engine, models, prompts, MCP server and plugin live in the npm
package. **npm remains the canonical distribution**: PyPI mirrors the same
version and is not a second source of features.

## Requirements

- Python 3.9+ (`requires-python` in `python/pyproject.toml`); the publish
  workflow uses Python 3.12.
- Node.js >= 18, including npm and npx.
- An authenticated OpenCode CLI: `npm install -g opencode-ai`.
- Network access on first run (or a warm npm cache), because `npx` may download
  the npm package. The wrapper does not bundle Node.js or OpenCode.

## One-time setup (Trusted Publishing)

No API token or repository secret is used: PyPI trusts GitHub's OIDC identity.

1. Create a PyPI account at <https://pypi.org/account/register/> and enable
   two-factor authentication; PyPI requires 2FA for publishing.
2. Open <https://pypi.org/manage/account/publishing/> and add a **pending
   trusted publisher**. The project does not exist yet, which is expected.

   | Field | Value |
   | --- | --- |
   | PyPI project name | `lv24-opencode-consilium` |
   | Owner | `LevapVeeskela` |
   | Repository name | `lv24-opencode-consilium` |
   | Workflow name | `pypi-publish.yml` |
   | Environment name | blank (or `pypi`, see below) |

3. Save. The first successful publish creates the project and converts the
   pending publisher into a normal trusted publisher. Do not create the project
   manually first, and do not add an API token.

The committed workflow has no `environment:`, so leave the PyPI environment
blank. For a GitHub environment named `pypi`, add `environment: pypi` to the
`publish` job and enter `pypi` on PyPI; both values must match exactly.

## Release flow

Publishing a GitHub release for tag `vX.Y.Z` triggers both npm-publish and
pypi-publish. Bump `package.json`, `python/pyproject.toml` and
`python/src/lv24_opencode_consilium/__init__.py` (`__version__`) to the same
version before tagging; the PyPI workflow fails fast if the tag and both
metadata files differ, and `test/version-consistency.test.mjs` checks all three.

1. Bump the version files and run the usual checks (`npm test`,
   `python -m build` in `python/`).
2. Commit, tag (`git tag vX.Y.Z`), push, and publish a GitHub release.
3. Watch the `pypi-publish` run in Actions.

Manual fallback, for example when a release tag predates the workflow:

```bash
gh workflow run pypi-publish.yml -f version=1.11.0
```

The input may include or omit the leading `v`. Existing versions are detected
through the public JSON API and skipped, so re-running is safe. PyPI never
allows re-uploading a filename; bump the version to replace a bad release.

## Tests

The launcher tests use only the standard library and do not need the package
installed:

```bash
python -m unittest discover -s python/tests -v
```

`.github/workflows/python-test.yml` runs the same command on Python 3.9-3.13.
It is manual-only (`gh workflow run python-test.yml`) and uses no secrets.

## Install and run

```bash
pip install lv24-opencode-consilium
consilium --help
consilium doctor
consilium "Review the authentication design"
```

Set `CONSILIUM_NPM_VERSION` to pin the npm CLI version the wrapper invokes
(default: the wrapper's own version):

```bash
CONSILIUM_NPM_VERSION=1.11.0 consilium "Review the API"
```

On PowerShell: `$env:CONSILIUM_NPM_VERSION = "1.11.0"`.

Upgrade with `pip install --upgrade lv24-opencode-consilium`. The PyPI version is
kept in lockstep with npm, so either installation route gives the same engine.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `invalid-publisher` or `Trusted publishing failed` | The owner, repository, workflow filename or environment does not match the pending publisher. Use `LevapVeeskela`, `lv24-opencode-consilium`, `pypi-publish.yml`; leave the environment blank unless the job declares it. |
| `id-token` or OIDC permission error | Keep `permissions: id-token: write` on the job. Do not replace Trusted Publishing with a token. |
| Version already exists | PyPI rejects duplicate filenames. Bump both version files and publish a new tag; the workflow skips existing versions automatically. |
| Upload rejected because 2FA is missing | Enable 2FA on the PyPI account. Publishing is blocked without it. |
| npm publishes but PyPI does not | Check the `pypi-publish` run. A tag/version mismatch fails before upload; fix it and use the manual dispatch. |
| Wrapper cannot find Node or OpenCode | Install Node.js >= 18 and `npm install -g opencode-ai`, authenticate OpenCode, then run `consilium doctor`. |

### TestPyPI (optional)

TestPyPI is a separate service with separate accounts. Add a second pending
trusted publisher at <https://test.pypi.org/manage/account/publishing/> with the
same owner, repository and workflow values, then point the upload at
`https://test.pypi.org/legacy/` (a local twine upload uses TestPyPI
credentials):

```bash
python -m twine upload --repository-url https://test.pypi.org/legacy/ python/dist/*
```

The committed workflow publishes to PyPI only and never handles tokens. For a CI
dry run, add a separate job that passes
`repository-url: https://test.pypi.org/legacy/` to the publish action. Use a
throwaway version such as `1.11.0rc1` and never reuse it for a real release.

## Cost

Public GitHub Actions minutes and PyPI hosting are free for public projects.
The workflow uses standard GitHub-hosted runners, OIDC and PyPI only; there are
no paid services, secrets or API tokens to maintain.
