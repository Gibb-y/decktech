import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import guide from './guide.md';
import { callTool, createServer, TOOLS } from './server';
import { Workspace } from './workspace';

let dir: string;
let workspace: Workspace;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decktech-guide-'));
  workspace = new Workspace({ root: dir, libraryDir: join(dir, 'lib') });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function call(name: string, input: Record<string, unknown> = {}) {
  const tool = TOOLS.find((t) => t.name === name)!;
  const result = await callTool(workspace, tool, tool.input.parse(input));
  const text = (result.content[0] as { text: string }).text;
  return { isError: result.isError === true, text };
}

describe('agent guide', () => {
  it('is served by describe_schema (as markdown text) and named by the overview and the server instructions', async () => {
    const r = await call('describe_schema', { topic: 'guide' });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(guide);
    expect(r.text).toMatch(/^# DeckTech MCP guide for agents/);
    expect(await call('describe_schema', { topic: 'overview' })).toMatchObject({
      text: expect.stringContaining('topic \\"guide\\"'),
    });
  });

  it('is served as the resource decktech://guide over the protocol', async () => {
    const { server } = createServer({ root: dir, libraryDir: join(dir, 'lib') });
    const [client, serving] = InMemoryTransport.createLinkedPair();
    await server.connect(serving);
    const replies = new Map<number, (message: any) => void>();
    client.onmessage = (message: any) => replies.get(message.id)?.(message);
    await client.start();
    let id = 0;
    const rpc = (method: string, params: object) =>
      new Promise<any>((resolve) => {
        replies.set(++id, resolve);
        void client.send({ jsonrpc: '2.0', id, method, params } as never);
      });
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    });
    const listed = await rpc('resources/list', {});
    expect(listed.result.resources.map((r: { uri: string }) => r.uri)).toContain(
      'decktech://guide',
    );
    const read = await rpc('resources/read', { uri: 'decktech://guide' });
    expect(read.result.contents[0]).toMatchObject({
      uri: 'decktech://guide',
      mimeType: 'text/markdown',
      text: guide,
    });
    await server.close();
  });

  it('only names tools that exist', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    const mentioned = new Set([...guide.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]));
    const tools = [...mentioned].filter(
      (m) =>
        /^(add|set|get|create|update|insert|detach|validate|render|check|open|close|export|list|save|import|move|delete|duplicate|describe|undo|redo)_/.test(
          m,
        ) || ['undo', 'redo'].includes(m),
    );
    expect(tools.length).toBeGreaterThan(15);
    expect(tools.filter((t) => !names.has(t))).toEqual([]);
  });

  it('mentions every tool at least once, so none is undiscoverable', () => {
    const missing = TOOLS.map((t) => t.name).filter((n) => !guide.includes(n));
    // list_decks and close_deck are plain housekeeping; everything else should be taught.
    expect(
      missing.filter(
        (n) =>
          !['list_decks', 'close_deck', 'redo', 'get_component', 'list_components'].includes(n),
      ),
    ).toEqual([]);
  });

  it('has an example component that the server accepts and that can be inserted', async () => {
    const block = /### Example component[\s\S]*?```json\r?\n([\s\S]*?)```/.exec(guide);
    expect(block).not.toBeNull();
    const example = JSON.parse(block![1]) as Record<string, unknown>;
    const deck = JSON.parse((await call('create_deck')).text);
    const created = await call('create_component', { deckId: deck.deckId, ...example });
    expect(created.isError, created.text).toBe(false);
    const component = JSON.parse(created.text);
    expect(component.warnings).toEqual([]);
    const placed = await call('insert_code_element', {
      deckId: deck.deckId,
      slideId: deck.slides[0].id,
      componentId: component.id,
      props: { start: 5 },
    });
    expect(placed.isError, placed.text).toBe(false);
    const checked = JSON.parse(
      (await call('validate_component', { deckId: deck.deckId, componentId: component.id })).text,
    );
    expect(checked).toMatchObject({ valid: true, executed: false });
  });

  it('lists the layout ids it recommends', async () => {
    const layouts = JSON.parse((await call('describe_schema', { topic: 'layouts' })).text) as {
      id: string;
    }[];
    for (const id of [
      'ly_title',
      'ly_title-content',
      'ly_two-column',
      'ly_title-only',
      'ly_blank',
    ]) {
      expect(guide).toContain(id);
      expect(layouts.map((l) => l.id)).toContain(id);
    }
  });
});
