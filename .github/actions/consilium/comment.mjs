#!/usr/bin/env node
/**
 * Post or update a single Consilium review comment on a pull request.
 *
 * Reads:
 *   GITHUB_TOKEN          Token with pull-requests: write (never logged).
 *   GITHUB_REPOSITORY     owner/repo.
 *   GITHUB_EVENT_PATH     Workflow event payload; pull_request.number is used.
 *   CONSILIUM_REPORT_FILE Report path (default: consilium-review.md in the workspace).
 *   GITHUB_API_URL        Optional GitHub API base, for GitHub Enterprise Server.
 *
 * Permission, network, and API failures are reported as workflow warnings and
 * exit 0. The Consilium policy gate is the only thing that should fail the job;
 * a comment failure must not hide exit code 3.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MARKER = '<!-- consilium:report -->';
const MAX_BODY_CHARS = 60_000;
const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = 'consilium-pr-review-action';

function commandEscape(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

function warn(message) {
  console.log(`::warning::${commandEscape(message)}`);
}

function notice(message) {
  console.log(`::notice::${commandEscape(message)}`);
}

function readEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function apiBase() {
  return (readEnv('GITHUB_API_URL') || 'https://api.github.com').replace(/\/+$/, '');
}

/**
 * Keep the sticky-comment marker even when the report is truncated. GitHub
 * rejects comments over 65536 characters, so cap with a little headroom.
 */
function limitBody(markdown) {
  const source = markdown.includes(MARKER) ? markdown : `${markdown}\n\n${MARKER}`;
  if (source.length <= MAX_BODY_CHARS) return source;

  const note =
    '\n\n> Consilium review truncated to fit GitHub\'s comment limit.' +
    ' The full report is `consilium-review.md` in the workflow workspace.\n\n';
  const available = Math.max(0, MAX_BODY_CHARS - note.length - MARKER.length);
  let head = source.slice(0, available);

  // Do not cut a UTF-16 surrogate pair in half.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);

  head = head.replaceAll(MARKER, '').trimEnd();
  return `${head}${note}${MARKER}`;
}

async function responseDetails(response) {
  try {
    const text = await response.text();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.message === 'string') return parsed.message;
    } catch {
      // Not JSON; use the text below.
    }
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Warn and return false for 403/404 (missing permission, fork PR, rate limit,
 * or a deleted PR). Other statuses are thrown and also downgraded to a warning
 * by main(), because comment failures must not replace the review gate.
 */
async function checkResponse(response, action) {
  if (response.ok) return true;

  const details = await responseDetails(response);
  const suffix = details ? `: ${details}` : '';
  if (response.status === 403 || response.status === 404) {
    warn(
      `${action} failed with HTTP ${response.status}${suffix}. ` +
        'The review comment was not posted. Check pull-requests: write, token scope, ' +
        'fork PR permissions (read-only token, no secrets), and API rate limits.'
    );
    return false;
  }

  throw new Error(`${action} failed with HTTP ${response.status}${suffix}`);
}

async function request(url, init = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${readEnv('GITHUB_TOKEN')}`,
    'x-github-api-version': API_VERSION,
    'user-agent': USER_AGENT,
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
  };

  return fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

async function findExistingComment(repoUrl, prNumber) {
  const perPage = 100;
  for (let page = 1; page <= 20; page += 1) {
    const response = await request(
      `${repoUrl}/issues/${prNumber}/comments?per_page=${perPage}&page=${page}`
    );
    if (!(await checkResponse(response, 'Listing pull request comments'))) {
      return { abort: true };
    }

    const comments = await response.json();
    if (!Array.isArray(comments)) {
      throw new Error('Unexpected response while listing pull request comments.');
    }

    const existing = comments.find(
      comment => typeof comment?.body === 'string' && comment.body.includes(MARKER)
    );
    if (existing) return { comment: existing };
    if (comments.length < perPage) return { comment: null };
  }

  // Plenty for a PR; avoid paging forever on a pathological thread.
  return { comment: null };
}

async function main() {
  const token = readEnv('GITHUB_TOKEN');
  if (!token) {
    warn('GITHUB_TOKEN is not set; skipping the Consilium review comment (the gate still applies).');
    return;
  }

  const repository = readEnv('GITHUB_REPOSITORY');
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    warn(`GITHUB_REPOSITORY '${repository}' is missing or invalid; skipping the comment.`);
    return;
  }

  const eventPath = readEnv('GITHUB_EVENT_PATH');
  if (!eventPath) {
    warn('GITHUB_EVENT_PATH is not set; skipping the Consilium review comment.');
    return;
  }

  let event;
  try {
    event = JSON.parse(await readFile(eventPath, 'utf8'));
  } catch (error) {
    warn(`Could not read the GitHub event payload: ${error.message}`);
    return;
  }

  const prNumber = Number(event?.pull_request?.number);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    warn('The event does not contain pull_request.number; skipping the comment.');
    return;
  }

  const reportPath = resolve(
    readEnv('GITHUB_WORKSPACE') || process.cwd(),
    readEnv('CONSILIUM_REPORT_FILE') || 'consilium-review.md'
  );

  let report;
  try {
    report = await readFile(reportPath, 'utf8');
  } catch {
    warn(`Consilium report not found at ${reportPath}; skipping the comment.`);
    return;
  }

  if (report.trim().length === 0) {
    warn(`Consilium report at ${reportPath} is empty; skipping the comment.`);
    return;
  }

  const body = limitBody(report.endsWith('\n') ? report : `${report}\n`);
  const [owner, repo] = repository.split('/');
  const repoUrl = `${apiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const existing = await findExistingComment(repoUrl, prNumber);
  if (existing.abort) return;

  const payload = JSON.stringify({ body });
  let response;
  if (existing.comment) {
    response = await request(`${repoUrl}/issues/comments/${existing.comment.id}`, {
      method: 'PATCH',
      body: payload
    });
    if (!(await checkResponse(response, 'Updating the Consilium review comment'))) return;
  } else {
    response = await request(`${repoUrl}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: payload
    });
    if (!(await checkResponse(response, 'Creating the Consilium review comment'))) return;
  }

  const result = await response.json().catch(() => null);
  const url = result && typeof result.html_url === 'string' ? ` (${result.html_url})` : '';
  notice(`Consilium review comment ${existing.comment ? 'updated' : 'created'}${url}.`);
}

main().catch(error => {
  warn(
    `Could not post the Consilium review comment: ` +
      `${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 0;
});
