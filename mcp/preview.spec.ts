import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { callTool, TOOLS } from './server';
import { Workspace } from './workspace';

const appDir = resolve(import.meta.dirname, '../dist/decktech/browser');

/** The browser tests need the built app (`npm run build`) and a Chromium (`npx playwright install chromium`). */
async function browserAvailable(): Promise<boolean> {
  if (!existsSync(join(appDir, 'index.html'))) return false;
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const available = await browserAvailable();

let dir: string;
let workspace: Workspace;

function setup(enabled: boolean): void {
  dir = mkdtempSync(join(tmpdir(), 'decktech-preview-'));
  mkdirSync(join(dir, 'work'));
  workspace = new Workspace({
    root: join(dir, 'work'),
    libraryDir: join(dir, 'lib'),
    preview: { enabled, appDir },
  });
}

async function call(name: string, input: Record<string, unknown> = {}) {
  const tool = TOOLS.find((t) => t.name === name)!;
  const parsed = tool.input.parse(input);
  const result = await callTool(workspace, tool, parsed);
  const text = (result.content[0] as { text: string }).text;
  const images = result.content.filter((c) => c.type === 'image') as {
    data: string;
    mimeType: string;
  }[];
  return result.isError ? { error: text, images } : { data: JSON.parse(text), images };
}

async function ok(name: string, input: Record<string, unknown> = {}) {
  const r = await call(name, input);
  if ('error' in r) throw new Error(`${name} failed: ${r.error}`);
  return r;
}

const pngSize = (base64: string) => {
  const bytes = Buffer.from(base64, 'base64');
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

afterEach(async () => {
  await workspace.previewer.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('previews are off by default', () => {
  beforeEach(() => setup(false));

  it('render_preview and validate_component run:true say how to enable them', async () => {
    const deck = (await ok('create_deck')).data;
    const slideId = deck.slides[0].id;
    expect((await call('render_preview', { deckId: deck.deckId, slideId })).error).toMatch(
      /DECKTECH_PREVIEW=1/,
    );
    const r = await call('validate_component', { js: 'deck.ready(() => {});', run: true });
    expect(r.error).toMatch(/DECKTECH_PREVIEW=1/);
    expect(r.error).toMatch(/"valid":true/);
  });

  it('does not need a browser for the static check', async () => {
    expect((await ok('validate_component', { js: 'let x = 1;' })).data).toMatchObject({
      valid: true,
      executed: false,
    });
  });
});

describe('previews without a built app', () => {
  it('say where to build it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'decktech-preview-'));
    workspace = new Workspace({
      root: dir,
      libraryDir: join(dir, 'lib'),
      preview: { enabled: true, appDir: join(dir, 'missing') },
    });
    const deck = (await ok('create_deck')).data;
    const r = await call('render_preview', { deckId: deck.deckId, slideId: deck.slides[0].id });
    expect(r.error).toMatch(/built app was not found/);
  });
});

describe.skipIf(!available)('previews in a browser', () => {
  beforeEach(() => setup(true));

  const COMPONENT = {
    name: 'Box',
    html: '<div id="b" style="width:100%;height:100%;background:#ff0000"></div>',
    js: 'deck.ready(({ props }) => { console.log("started " + props.label); });',
    propSchema: [{ key: 'label', type: 'string', label: 'Label', default: 'hello' }],
  };

  it('draws a slide with text and a running code component and reports what it logged', async () => {
    const deck = (await ok('create_deck', { title: 'P' })).data;
    const deckId = deck.deckId;
    const slideId = deck.slides[0].id;
    await ok('add_text', { deckId, slideId, text: 'Hello preview', role: 'title', x: 100, y: 60 });
    const { id } = (await ok('create_component', { deckId, ...COMPONENT })).data;
    const el = (
      await ok('insert_code_element', {
        deckId,
        slideId,
        componentId: id,
        x: 960,
        y: 540,
        w: 800,
        h: 400,
      })
    ).data;

    const r = await ok('render_preview', { deckId, slideId, width: 640, settleMs: 1500 });
    expect(pngSize(r.images[0].data)).toEqual({ width: 640, height: 360 });
    expect(r.data.errors).toEqual([]);
    expect(r.data.frames).toEqual([{ elementId: el.id, running: true }]);
    expect(r.data.console.map((c: { text: string }) => c.text)).toContain('started hello');

    const cropped = await ok('render_preview', {
      deckId,
      slideId,
      elementId: el.id,
      width: 960,
      settleMs: 1500,
      path: 'out/box.png',
    });
    expect(pngSize(cropped.images[0].data)).toEqual({ width: 400, height: 200 });
    expect(readFileSync(join(workspace.root, 'out', 'box.png')).length).toBeGreaterThan(100);
  });

  it('shows a props change in the picture and keeps the deck untouched', async () => {
    const deck = (await ok('create_deck')).data;
    const { deckId } = deck;
    const slideId = deck.slides[0].id;
    const { id } = (await ok('create_component', { deckId, ...COMPONENT })).data;
    const el = (await ok('insert_code_element', { deckId, slideId, componentId: id })).data;
    await ok('update_code_element_props', {
      deckId,
      elementId: el.id,
      props: { label: 'changed' },
    });
    const r = await ok('render_preview', { deckId, slideId, settleMs: 1000 });
    expect(r.data.console.map((c: { text: string }) => c.text)).toContain('started changed');
    expect((await ok('undo', { deckId })).data.undone).toBe(true);
  });

  it('reports a script that throws and a frame that does not start', async () => {
    const deck = (await ok('create_deck')).data;
    const { deckId } = deck;
    const slideId = deck.slides[0].id;
    const { id } = (
      await ok('create_component', {
        deckId,
        name: 'Bad',
        js: 'deck.ready(() => { throw new Error("boom in component"); });',
      })
    ).data;
    await ok('insert_code_element', { deckId, slideId, componentId: id });
    const r = await ok('render_preview', { deckId, slideId, settleMs: 1500 });
    expect(JSON.stringify(r.data.errors)).toMatch(/boom in component/);
  });

  it('cannot reach the network from a component', async () => {
    const deck = (await ok('create_deck')).data;
    const { deckId } = deck;
    const slideId = deck.slides[0].id;
    const { id } = (
      await ok('create_component', {
        deckId,
        name: 'Net',
        js: 'fetch("https://example.com/").then(() => console.log("reached")).catch(() => console.log("blocked"));',
      })
    ).data;
    await ok('insert_code_element', { deckId, slideId, componentId: id });
    const r = await ok('render_preview', { deckId, slideId, settleMs: 1500 });
    const lines = r.data.console.map((c: { text: string }) => c.text);
    expect(lines).not.toContain('reached');
  });

  it('refuses an element of another slide and an unknown slide', async () => {
    const deck = (await ok('create_deck')).data;
    const { deckId } = deck;
    const first = deck.slides[0].id;
    const second = (await ok('add_slide', { deckId })).data.id;
    const text = (await ok('add_text', { deckId, slideId: first, text: 'x' })).data;
    expect(
      (await call('render_preview', { deckId, slideId: second, elementId: text.id })).error,
    ).toMatch(/is on slide/);
    expect((await call('render_preview', { deckId, slideId: 'nope' })).error).toMatch(
      /does not exist/,
    );
  });

  it('validate_component run:true runs a valid component and skips an invalid one', async () => {
    const good = await ok('validate_component', {
      ...COMPONENT,
      run: true,
      settleMs: 1000,
    });
    expect(good.data).toMatchObject({ valid: true, executed: true, ok: true });
    expect(good.data.runtime.console.map((c: { text: string }) => c.text)).toContain(
      'started hello',
    );
    expect(good.images).toHaveLength(1);

    const bad = await ok('validate_component', { js: 'let let =', run: true });
    expect(bad.data).toMatchObject({ valid: false, executed: false });
    expect(bad.data.runtime).toMatch(/not run/);
    expect(bad.images).toHaveLength(0);

    const throwing = await ok('validate_component', {
      js: 'deck.ready(() => { throw new Error("late failure"); });',
      run: true,
      settleMs: 1000,
    });
    expect(throwing.data.ok).toBe(false);
    expect(JSON.stringify(throwing.data.runtime.errors)).toMatch(/late failure/);
  });

  it('renders embedded images', async () => {
    const deck = (await ok('create_deck')).data;
    const { deckId } = deck;
    const slideId = deck.slides[0].id;
    // 1x1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(workspace.root, 'dot.png'), png);
    await ok('add_image', { deckId, slideId, path: 'dot.png', alt: 'a dot' });
    const r = await ok('render_preview', { deckId, slideId, settleMs: 200 });
    expect(r.data.errors).toEqual([]);
  });
});
