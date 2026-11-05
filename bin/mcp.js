#!/usr/bin/env node

import { readFileSync } from 'node:fs';

function readVersion() {
  try {
    const content = readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
    const parsed = JSON.parse(content);
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

import('../dist/mcp.js')
  .then(({ startMcpServer }) => {
    const running = startMcpServer({ version: readVersion() });
    console.error('opencode-consilium MCP server running on stdio');
    return running;
  })
  .catch((error) => {
    console.error('MCP server failed:', error);
    process.exit(1);
  });
