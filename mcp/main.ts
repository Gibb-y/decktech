import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server';

// Settings come from the environment of the MCP client's config, never from the agent.
const root = resolve(process.env['DECKTECH_WORKSPACE'] ?? process.cwd());
mkdirSync(root, { recursive: true });
const libraryDir = resolve(process.env['DECKTECH_LIBRARY'] ?? join(root, '.decktech', 'library'));

const { server } = createServer({ root, libraryDir });
await server.connect(new StdioServerTransport());
// stdout carries the protocol; diagnostics go to stderr.
console.error(`decktech MCP server ready (workspace ${root})`);
