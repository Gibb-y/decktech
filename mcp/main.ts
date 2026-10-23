import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server';

// Settings come from the environment of the MCP client's config, never from the agent.
const root = resolve(process.env['DECKTECH_WORKSPACE'] ?? process.cwd());
mkdirSync(root, { recursive: true });
const libraryDir = resolve(process.env['DECKTECH_LIBRARY'] ?? join(root, '.decktech', 'library'));

const appDir = resolve(
  process.env['DECKTECH_APP_DIR'] ??
    fileURLToPath(new URL('../dist/decktech/browser', import.meta.url)),
);
const preview = { enabled: process.env['DECKTECH_PREVIEW'] === '1', appDir };

const { server, workspace } = createServer({ root, libraryDir, preview });
process.once('exit', () => void workspace.previewer.close());
await server.connect(new StdioServerTransport());
// stdout carries the protocol; diagnostics go to stderr.
console.error(`decktech MCP server ready (workspace ${root})`);
