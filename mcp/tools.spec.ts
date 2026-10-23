import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArchive } from '../src/app/library/archive/reader';
import { callTool, TOOLS } from './server';
import { Workspace } from './workspace';

let dir: string;
let workspace: Workspace;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decktech-mcp-'));
  mkdirSync(join(dir, 'work'));
  workspace = new Workspace({ root: join(dir, 'work'), libraryDir: join(dir, 'work', '.decktech', 'library') });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Calls a tool the way the SDK does: the input goes through the tool's schema first. */
async function call(name: string, input: Record<string, unknown> = {}): Promise<{ error?: string; data: any }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) return { error: `invalid input: ${parsed.error.message}`, data: undefined };
  const result = await callTool(workspace, tool, parsed.data);
  const text = (result.content[0] as { text: string }).text;
  return result.isError ? { error: text, data: undefined } : { data: JSON.parse(text) };
}

async function ok(name: string, input: Record<string, unknown> = {}) {
  const r = await call(name, input);
  if (r.error) throw new Error(`${name} failed: ${r.error}`);
  return r.data;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function newDeck(title = 'T') {
  const outline = await ok('create_deck', { title });
  return { deckId: outline.deckId as string, firstSlide: outline.slides[0].id as string };
}

const COUNTER = {
  name: 'Counter',
  html: '<div id="n"></div>',
  css: '#n { color: var(--deck-color-text); }',
  js: 'deck.ready(({ props }) => { document.getElementById("n").textContent = props.start; });',
  propSchema: [{ key: 'start', type: 'number', label: 'Start', default: 1, min: 0, max: 10 }],
};

describe('tool list', () => {
  it('has unique names and every priority 1 tool of the issue (except the browser-based preview)', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const wanted of [
      'create_component', 'update_component', 'list_components', 'get_component', 'insert_code_element',
      'update_code_element_props', 'detach_component', 'validate_component', 'import_from_library', 'save_to_library',
    ]) expect(names).toContain(wanted);
  });

  it('rejects input that does not fit the schema', async () => {
    expect((await call('create_deck', { title: '' })).error).toMatch(/invalid input/);
    expect((await call('add_slide', {})).error).toMatch(/invalid input/);
  });
});

describe('decks and slides', () => {
  it('creates, outlines and renames a deck and switches the theme', async () => {
    const { deckId } = await newDeck('Talk');
    await ok('set_deck_metadata', { deckId, title: 'Renamed', theme: 'dark' });
    const full = await ok('get_deck', { deckId, detail: 'full' });
    expect(full.title).toBe('Renamed');
    expect(full.theme.colors.background).toBe('#14161a');
    expect((await call('set_deck_metadata', { deckId })).error).toMatch(/at least|Give a title/);
    expect((await call('get_deck', { deckId: 'nope' })).error).toMatch(/No deck "nope" is open/);
    expect((await call('get_deck', { deckId: 'toString' })).error).toMatch(/No deck "toString" is open/);
  });

  it('adds, duplicates, moves and deletes slides with actionable errors', async () => {
    const { deckId, firstSlide } = await newDeck();
    const added = await ok('add_slide', { deckId, layoutId: 'ly_title-content', notes: 'hi' });
    expect(added.elements).toHaveLength(2);
    const copy = await ok('duplicate_slide', { deckId, slideId: added.id });
    expect(copy.index).toBe(2);
    expect(copy.elements.map((e: { id: string }) => e.id)).not.toEqual(added.elements.map((e: { id: string }) => e.id));
    await ok('move_slide', { deckId, slideId: copy.id, toIndex: 0 });
    expect((await ok('get_deck', { deckId })).slides[0].id).toBe(copy.id);
    expect((await call('move_slide', { deckId, slideId: copy.id, toIndex: 9 })).error).toMatch(/out of range/);
    expect((await call('add_slide', { deckId, layoutId: 'nope' })).error).toMatch(/Layout "nope" does not exist/);
    expect((await call('add_slide', { deckId, index: 99 })).error).toMatch(/out of range/);
    await ok('set_layout', { deckId, slideId: firstSlide, layoutId: 'ly_title-only' });
    await ok('delete_slide', { deckId, slideId: copy.id });
    await ok('delete_slide', { deckId, slideId: added.id });
    expect((await call('delete_slide', { deckId, slideId: firstSlide })).error).toMatch(/at least one slide/);
    expect((await call('delete_slide', { deckId, slideId: 'gone' })).error).toMatch(/does not exist/);
  });

  it('undoes and redoes whole tool calls and keeps the deck unchanged when a call fails', async () => {
    const { deckId, firstSlide } = await newDeck();
    await ok('add_text', { deckId, slideId: firstSlide, text: 'Hello' });
    const before = await ok('get_deck', { deckId, detail: 'full' });
    expect((await call('add_text', { deckId, slideId: firstSlide, text: 'x', color: 'not a colour!' })).error).toMatch(/invalid|not applied|Invalid/i);
    expect(await ok('get_deck', { deckId, detail: 'full' })).toEqual(before);
    expect((await ok('undo', { deckId })).undone).toBe(true);
    expect((await ok('get_deck', { deckId })).slides[0].elements).toHaveLength(0);
    expect((await ok('redo', { deckId })).redone).toBe(true);
    expect((await ok('get_deck', { deckId })).slides[0].elements).toHaveLength(1);
    expect((await ok('redo', { deckId })).redone).toBe(false);
  });

  it('limits the number of open decks', async () => {
    for (let i = 0; i < 20; i++) await ok('create_deck');
    expect((await call('create_deck')).error).toMatch(/20 decks are open/);
    const { deckId } = (await ok('list_decks'))[0];
    await ok('close_deck', { deckId });
    await ok('create_deck');
  });
});

describe('elements', () => {
  it('adds text with role sizes, theme tokens and bullet lists', async () => {
    const { deckId, firstSlide } = await newDeck();
    const title = await ok('add_text', { deckId, slideId: firstSlide, text: 'Title', role: 'title', align: 'center' });
    await ok('add_text', { deckId, slideId: firstSlide, text: '- one\n- two', color: '#112233' });
    const slide = (await ok('get_deck', { deckId, detail: 'full' })).slides[0];
    expect(slide.elements[0].id).toBe(title.id);
    expect(slide.elements[0]).toMatchObject({ sizeToken: 'title', align: 'center', color: { token: 'text' } });
    expect(slide.elements[1].color).toBe('#112233');
    expect(slide.elements[1].rich.content[0].type).toBe('bullet_list');
  });

  it('fills the sample text of a placeholder with set_text', async () => {
    const { deckId } = await newDeck();
    const slide = await ok('add_slide', { deckId, layoutId: 'ly_title' });
    const result = await ok('set_text', { deckId, elementId: slide.elements[0].id, text: 'Real title', heading: true });
    expect(result.summary).toBe('"Real title"');
    expect((await call('set_text', { deckId, elementId: 'nope', text: 'x' })).error).toMatch(/does not exist/);
  });

  it('adds shapes, moves, restyles and reorders elements', async () => {
    const { deckId, firstSlide } = await newDeck();
    const a = await ok('add_shape', { deckId, slideId: firstSlide, shape: 'ellipse', fill: 'accent', x: 10, y: 20, w: 100, h: 50 });
    const b = await ok('add_shape', { deckId, slideId: firstSlide, stroke: '#000' });
    await ok('move_element', { deckId, elementId: a.id, x: 300 });
    await ok('update_element', { deckId, elementId: a.id, changes: { rotation: 45, hidden: true, fill: 'muted' } });
    const el = (await ok('get_deck', { deckId, detail: 'full' })).slides[0].elements[0];
    expect(el).toMatchObject({ x: 300, y: 20, w: 100, h: 50, rotation: 45, hidden: true, fill: { kind: 'solid', color: { token: 'muted' } } });
    expect((await ok('set_z_order', { deckId, elementId: a.id, move: 'front' })).order).toEqual([b.id, a.id]);
    expect((await call('move_element', { deckId, elementId: a.id })).error).toMatch(/at least one/);
    expect((await call('update_element', { deckId, elementId: a.id, changes: { bogus: 1 } })).error).toMatch(/not a settable property/);
    expect((await call('update_element', { deckId, elementId: a.id, changes: JSON.parse('{"__proto__": {"x": 1}}') })).error).toMatch(/at least one property/);
    expect((await call('update_element', { deckId, elementId: a.id, changes: { x: 'far' } })).error).toMatch(/finite number/);
    expect((await call('update_element', { deckId, elementId: a.id, changes: { text: 'x' } })).error).toMatch(/dedicated tool/);
    expect((await call('add_shape', { deckId, slideId: firstSlide, w: Number.NaN })).error).toMatch(/invalid input/);
    await ok('delete_element', { deckId, elementIds: [a.id, b.id] });
    expect((await call('delete_element', { deckId, elementIds: [a.id] })).error).toMatch(/does not exist/);
  });

  it('embeds images from the workspace, deduplicates them and requires alt text', async () => {
    const { deckId, firstSlide } = await newDeck();
    writeFileSync(join(workspace.root, 'pic.png'), PNG);
    writeFileSync(join(workspace.root, 'fake.png'), 'not a png');
    writeFileSync(join(workspace.root, 'doc.txt'), 'x');
    const image = await ok('add_image', { deckId, slideId: firstSlide, path: 'pic.png', alt: 'A picture' });
    await ok('add_image', { deckId, slideId: firstSlide, path: 'pic.png', alt: '', decorative: true });
    expect(Object.keys((await ok('get_deck', { deckId, detail: 'full' })).assets)).toEqual([image.assetId]);
    expect((await call('add_image', { deckId, slideId: firstSlide, path: 'pic.png', alt: '' })).error).toMatch(/alt text/);
    expect((await call('add_image', { deckId, slideId: firstSlide, path: 'pic.png', alt: 'x', decorative: true })).error).toMatch(/decorative image has an empty alt/);
    expect((await call('add_image', { deckId, slideId: firstSlide, path: 'fake.png', alt: 'x' })).error).toMatch(/not a valid image\/png/);
    expect((await call('add_image', { deckId, slideId: firstSlide, path: 'doc.txt', alt: 'x' })).error).toMatch(/not a supported image type/);
    expect((await call('add_image', { deckId, slideId: firstSlide, path: 'missing.png', alt: 'x' })).error).toMatch(/does not exist/);
    expect((await call('set_alt_text', { deckId, elementId: image.id, alt: ' Better ' })).data.alt).toBe('Better');
    const text = await ok('add_text', { deckId, slideId: firstSlide, text: 'x' });
    expect((await call('set_alt_text', { deckId, elementId: text.id, alt: 'x' })).error).toMatch(/only images have alt text/);
  });

  it('reports accessibility problems it can see', async () => {
    const { deckId, firstSlide } = await newDeck();
    writeFileSync(join(workspace.root, 'pic.png'), PNG);
    const image = await ok('add_image', { deckId, slideId: firstSlide, path: 'pic.png', alt: '', decorative: true });
    await ok('add_text', { deckId, slideId: firstSlide, text: 'pale', color: '#eeeeee' });
    await ok('add_text', { deckId, slideId: firstSlide, text: '' });
    const { problems } = await ok('check_accessibility', { deckId });
    expect(problems.map((p: { problem: string }) => p.problem).join('\n')).toMatch(/image has no alt text/);
    expect(problems.some((p: { problem: string }) => /contrast is/.test(p.problem))).toBe(true);
    expect(problems.some((p: { problem: string }) => /empty/.test(p.problem))).toBe(true);
    expect(problems.some((p: { elementId?: string }) => p.elementId === image.id)).toBe(true);
  });

  it('sets speaker notes', async () => {
    const { deckId, firstSlide } = await newDeck();
    await ok('set_speaker_notes', { deckId, slideId: firstSlide, notes: 'Say hi' });
    expect((await ok('get_deck', { deckId, detail: 'full' })).slides[0].notes).toBe('Say hi');
  });
});

describe('code components', () => {
  it('creates, lists and reads a component', async () => {
    const { deckId } = await newDeck();
    const created = await ok('create_component', { deckId, ...COUNTER });
    expect(created).toMatchObject({ name: 'Counter', props: ['start'], instances: 0, permissions: [] });
    expect(await ok('list_components', { deckId })).toHaveLength(1);
    const got = await ok('get_component', { deckId, componentId: created.id });
    expect(got).toMatchObject({ js: COUNTER.js, html: COUNTER.html, instances: 0, slides: [] });
    expect((await call('get_component', { deckId, componentId: 'nope' })).error).toMatch(/does not exist in this deck/);
    expect((await call('list_components', {})).error).toMatch(/Give a deckId/);
  });

  it.each([
    ['a script syntax error', { js: 'const = ;' }, /syntax error: .*line 1/],
    ['an invalid permission', { permissions: ['root'] }, /invalid input/],
    ['a prop whose default is out of range', { propSchema: [{ key: 'n', type: 'number', label: 'N', default: 99, min: 0, max: 10 }] }, /not valid and was not saved/],
    ['a select whose default is not an option', { propSchema: [{ key: 's', type: 'select', label: 'S', options: [{ value: 'a', label: 'A' }], default: 'b' }] }, /not valid and was not saved/],
    ['duplicate prop keys', { propSchema: [{ key: 'k', type: 'string', label: 'K', default: '' }, { key: 'k', type: 'string', label: 'K2', default: '' }] }, /not valid and was not saved/],
    ['an oversized script', { js: `//${'x'.repeat(1_000_001)}` }, /invalid input/],
  ])('refuses a component with %s and stores nothing', async (_name, patch, message) => {
    const { deckId } = await newDeck();
    const r = await call('create_component', { deckId, ...COUNTER, ...patch });
    expect(r.error).toMatch(message);
    expect(await ok('list_components', { deckId })).toEqual([]);
  });

  it('accepts ES module syntax and warns about likely mistakes without refusing', async () => {
    const { deckId } = await newDeck();
    const r = await ok('create_component', {
      deckId, name: 'Risky', html: '<script>1</script><button onclick="x()">b</button>', css: '@import url(a.css);',
      js: 'import("https://x.test/a.js"); await 1; fetch("/x"); localStorage.x = 1; export const a = 1;', permissions: ['network'],
    });
    const w = r.warnings.join('\n');
    expect(w).toMatch(/never calls deck.ready/);
    expect(w).toMatch(/Inline <script>/);
    expect(w).toMatch(/Inline event attributes/);
    expect(w).toMatch(/External stylesheets/);
    expect(w).toMatch(/localStorage/);
    expect(w).toMatch(/Trust dialog will flag/);
  });

  it('inserts an instance with props, applies defaults and rejects bad props', async () => {
    const { deckId, firstSlide } = await newDeck();
    const { id } = await ok('create_component', { deckId, ...COUNTER });
    const placed = await ok('insert_code_element', { deckId, slideId: firstSlide, componentId: id, props: { start: 4 }, x: 100, y: 50, w: 400, h: 300 });
    expect(placed).toMatchObject({ type: 'code', x: 100, y: 50, w: 400, h: 300, props: { start: 4 } });
    const defaulted = await ok('insert_code_element', { deckId, slideId: firstSlide, componentId: id });
    expect(defaulted.props).toEqual({ start: 1 });
    const before = await ok('get_deck', { deckId, detail: 'full' });
    expect((await call('insert_code_element', { deckId, slideId: firstSlide, componentId: id, props: { start: 99 } })).error).toMatch(/"Start" must be at most 10/);
    expect((await call('insert_code_element', { deckId, slideId: firstSlide, componentId: id, props: { nope: 1 } })).error).toMatch(/not a prop of component/);
    expect((await call('insert_code_element', { deckId, slideId: firstSlide, componentId: 'ghost' })).error).toMatch(/does not exist in this deck/);
    expect(await ok('get_deck', { deckId, detail: 'full' })).toEqual(before);
    expect((await call('update_code_element_props', { deckId, elementId: placed.id, props: { start: 'x' } })).error).toMatch(/must be a number/);
    expect((await ok('update_code_element_props', { deckId, elementId: placed.id, props: { start: 7 } })).props).toEqual({ start: 7 });
    const text = await ok('add_text', { deckId, slideId: firstSlide, text: 'x' });
    expect((await call('update_code_element_props', { deckId, elementId: text.id, props: {} })).error).toMatch(/not a code component/);
  });

  it('reports how many instances share a definition on update, and detach makes one unique', async () => {
    const { deckId, firstSlide } = await newDeck();
    const { id } = await ok('create_component', { deckId, ...COUNTER });
    const one = await ok('insert_code_element', { deckId, slideId: firstSlide, componentId: id });
    await ok('insert_code_element', { deckId, slideId: firstSlide, componentId: id });
    expect((await call('detach_component', { deckId, elementId: 'nope' })).error).toMatch(/does not exist/);
    const updated = await ok('update_component', { deckId, componentId: id, js: 'deck.ready(() => {});', name: 'Counter 2' });
    expect(updated).toMatchObject({ name: 'Counter 2', shared: true, instances: 2 });
    expect(updated.usedOn).toEqual([{ slideId: firstSlide, number: 1, elementIds: expect.any(Array) }]);
    expect(updated.note).toMatch(/detach_component/);
    const copy = await ok('detach_component', { deckId, elementId: one.id });
    expect(copy.name).toBe('Counter 2 (copy)');
    const after = await ok('update_component', { deckId, componentId: id, css: 'b {}' });
    expect(after).toMatchObject({ shared: false, instances: 1 });
    expect((await call('detach_component', { deckId, elementId: one.id })).error).toMatch(/not shared/);
  });

  it('refuses invalid updates without changing the component', async () => {
    const { deckId } = await newDeck();
    const { id } = await ok('create_component', { deckId, ...COUNTER });
    const before = await ok('get_component', { deckId, componentId: id });
    expect((await call('update_component', { deckId, componentId: id, js: 'let let =' })).error).toMatch(/syntax error/);
    expect((await call('update_component', { deckId, componentId: id, propSchema: [{ key: 'a', type: 'number', label: 'A', default: 'x' }] })).error).toMatch(/not valid/);
    expect((await call('update_component', { deckId, componentId: id })).error).toMatch(/at least one field/);
    expect((await call('update_component', { deckId, componentId: 'nope', js: '' })).error).toMatch(/does not exist/);
    expect(await ok('get_component', { deckId, componentId: id })).toEqual(before);
  });

  it('falls back to defaults for instance props the new schema no longer accepts', async () => {
    const { deckId, firstSlide } = await newDeck();
    const { id } = await ok('create_component', { deckId, ...COUNTER });
    const el = await ok('insert_code_element', { deckId, slideId: firstSlide, componentId: id, props: { start: 9 } });
    await ok('update_component', { deckId, componentId: id, propSchema: [{ key: 'start', type: 'number', label: 'Start', default: 2, min: 0, max: 5 }] });
    expect((await ok('update_code_element_props', { deckId, elementId: el.id, props: { start: 3 } })).props).toEqual({ start: 3 });
  });

  it('validates a component without running it', async () => {
    const { deckId } = await newDeck();
    const { id } = await ok('create_component', { deckId, ...COUNTER });
    expect(await ok('validate_component', { deckId, componentId: id })).toMatchObject({ valid: true, errors: [], executed: false });
    const bad = await ok('validate_component', { js: 'function (' });
    expect(bad).toMatchObject({ valid: false, executed: false });
    expect(bad.errors[0]).toMatch(/syntax error/);
    expect(await ok('validate_component', { js: 'globalThis.__ran = true; throw new Error("boom");' })).toMatchObject({ valid: true });
    expect((globalThis as { __ran?: boolean }).__ran).toBeUndefined();
    expect((await call('validate_component', {})).error).toMatch(/at least one of/);
    expect((await call('validate_component', { componentId: id })).error).toMatch(/Give the deckId/);
  });

  it('shares components across decks through the file library', async () => {
    const a = await newDeck('A');
    const b = await newDeck('B');
    const { id } = await ok('create_component', { deckId: a.deckId, ...COUNTER });
    expect((await ok('save_to_library', { deckId: a.deckId, componentId: id })).id).toBe(id);
    expect(await ok('list_components', { source: 'library' })).toEqual([expect.objectContaining({ id, name: 'Counter' })]);
    expect((await ok('get_component', { source: 'library', componentId: id })).js).toBe(COUNTER.js);

    const imported = await ok('import_from_library', { deckId: b.deckId, libraryId: id });
    expect(imported.id).toBe(id);
    expect((await ok('import_from_library', { deckId: b.deckId, libraryId: id })).id).toBe(id);
    expect(await ok('list_components', { deckId: b.deckId })).toHaveLength(1);

    await ok('update_component', { deckId: b.deckId, componentId: id, css: 'p {}' });
    const fresh = await ok('import_from_library', { deckId: b.deckId, libraryId: id });
    expect(fresh.id).not.toBe(id);
    expect(await ok('list_components', { deckId: b.deckId })).toHaveLength(2);

    expect((await call('import_from_library', { deckId: b.deckId, libraryId: 'missing' })).error).toMatch(/no component "missing"/);
    expect((await call('import_from_library', { deckId: b.deckId, libraryId: '../x' })).error).toMatch(/missing|not a valid library id|no component/);
    expect((await call('get_component', { source: 'library', componentId: 'missing' })).error).toMatch(/no component/);
  });

  it('ignores damaged library files', async () => {
    mkdirSync(workspace.libraryDir, { recursive: true });
    writeFileSync(join(workspace.libraryDir, 'broken.json'), '{nope');
    writeFileSync(join(workspace.libraryDir, 'wrong.json'), JSON.stringify({ def: { id: 'other' }, assets: {}, savedAt: 1 }));
    expect(await ok('list_components', { source: 'library' })).toEqual([]);
  });
});

describe('files: export, open, trust and path safety', () => {
  async function buildDeck() {
    const { deckId, firstSlide } = await newDeck('Acceptance');
    writeFileSync(join(workspace.root, 'pic.png'), PNG);
    const s2 = await ok('add_slide', { deckId, layoutId: 'ly_title-content', notes: 'Notes' });
    await ok('set_text', { deckId, elementId: s2.elements[0].id, text: 'Second', heading: true });
    await ok('add_text', { deckId, slideId: firstSlide, text: 'Welcome', role: 'title' });
    await ok('add_image', { deckId, slideId: firstSlide, path: 'pic.png', alt: 'A picture' });
    const { id } = await ok('create_component', { deckId, ...COUNTER });
    await ok('insert_code_element', { deckId, slideId: s2.id, componentId: id, props: { start: 5 } });
    return deckId;
  }

  it('exports a multi-slide deck with text, image and code that DeckTech\'s reader accepts as untrusted code', async () => {
    const deckId = await buildDeck();
    const out = await ok('export_deck', { deckId, path: 'out/talk.deck' });
    expect(out).toMatchObject({ slides: 2, components: 1, hasCode: true });
    const read = await readArchive(new Uint8Array(readFileSync(join(workspace.root, 'out', 'talk.deck'))));
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.hasCode).toBe(true); // DeckArchive.importBytes records a pending trust decision for this
    expect(read.value.assets.size).toBe(1);
    expect(read.value.deck.slides).toHaveLength(2);
  });

  it('exports a deck without code as hasCode false', async () => {
    const { deckId } = await newDeck();
    await ok('export_deck', { deckId, path: 'plain.deck' });
    const read = await readArchive(new Uint8Array(readFileSync(join(workspace.root, 'plain.deck'))));
    expect(read.ok && read.value.hasCode).toBe(false);
  });

  it('opens an exported deck again, flags its code, and gives a taken id a new one', async () => {
    const deckId = await buildDeck();
    await ok('export_deck', { deckId, path: 'talk.deck' });
    const opened = await ok('open_deck', { path: 'talk.deck' });
    expect(opened.hasCode).toBe(true);
    expect(opened.note).toMatch(/never runs it/);
    expect(opened.deckId).not.toBe(deckId);
    expect(opened.slides).toHaveLength(2);
    await ok('export_deck', { deckId: opened.deckId, path: 'again.deck' });
    expect(readFileSync(join(workspace.root, 'again.deck')).length).toBeGreaterThan(0);
  });

  it('does not overwrite unless asked', async () => {
    const { deckId } = await newDeck();
    await ok('export_deck', { deckId, path: 'a.deck' });
    expect((await call('export_deck', { deckId, path: 'a.deck' })).error).toMatch(/exists already/);
    await ok('export_deck', { deckId, path: 'a.deck', overwrite: true });
    expect((await call('export_deck', { deckId, path: 'a.txt' })).error).toMatch(/invalid input/);
  });

  it('rejects files that are not decks', async () => {
    writeFileSync(join(workspace.root, 'bad.deck'), 'not a zip');
    expect((await call('open_deck', { path: 'bad.deck' })).error).toMatch(/cannot be opened/);
    expect((await call('open_deck', { path: 'absent.deck' })).error).toMatch(/does not exist/);
  });

  it('keeps every file operation inside the workspace folder', async () => {
    const { deckId, firstSlide } = await newDeck();
    writeFileSync(join(dir, 'secret.png'), PNG);
    expect((await call('export_deck', { deckId, path: '../escape.deck' })).error).toMatch(/outside the workspace/);
    expect((await call('export_deck', { deckId, path: join(dir, 'abs.deck') })).error).toMatch(/outside the workspace/);
    expect((await call('add_image', { deckId, slideId: firstSlide, path: '../secret.png', alt: 'x' })).error).toMatch(/outside the workspace/);
    expect((await call('open_deck', { path: '../x.deck' })).error).toMatch(/outside the workspace/);
    expect((await call('export_deck', { deckId, path: 'nul\0.deck' })).error).toMatch(/null character|invalid/);
    try {
      symlinkSync(dir, join(workspace.root, 'link'), 'junction');
    } catch {
      return; // links not allowed on this machine
    }
    expect((await call('add_image', { deckId, slideId: firstSlide, path: 'link/secret.png', alt: 'x' })).error).toMatch(/outside the workspace/);
    expect((await call('export_deck', { deckId, path: 'link/new.deck' })).error).toMatch(/outside the workspace/);
  });
});

describe('review fixes', () => {
  it('add_slide without a layout uses the Blank layout even when it is not the first one', async () => {
    const { deckId } = await newDeck();
    const deck = workspace.get(deckId);
    const reordered = { ...deck.deck, layouts: [...deck.deck.layouts].reverse() };
    const other = workspace.add(reordered).session;
    const added = await ok('add_slide', { deckId: other.deck.id });
    expect(added.layoutId).toBe('ly_blank');
  });

  it('validate_component checks a revision of a stored component and rejects a stray deckId', async () => {
    const { deckId } = await newDeck();
    const { id } = await ok('create_component', { deckId, ...COUNTER });
    const revised = await ok('validate_component', { deckId, componentId: id, js: 'let let =' });
    expect(revised.valid).toBe(false);
    expect((await ok('get_component', { deckId, componentId: id })).js).toBe(COUNTER.js);
    expect((await call('validate_component', { deckId, js: 'x' })).error).toMatch(/only used together with componentId/);
  });

  it('does not warn about ordinary property chains or visible text', async () => {
    const { warnings } = await ok('validate_component', { html: '<p>Turn on = "yes"</p>', js: 'deck.ready(() => { node.parent.x = layout.top.px; });' });
    expect(warnings.join(' ')).not.toMatch(/Inline event attributes|parent\/top/);
  });

  it('refuses a dangling link inside the workspace instead of writing through it', async () => {
    const { deckId } = await newDeck();
    try {
      symlinkSync(join(dir, 'nowhere.deck'), join(workspace.root, 'out.deck'), 'file');
    } catch {
      return;
    }
    expect((await call('export_deck', { deckId, path: 'out.deck' })).error).toMatch(/points nowhere/);
  });

  it('reports contrast it could not check', async () => {
    const { deckId, firstSlide } = await newDeck();
    await ok('add_text', { deckId, slideId: firstSlide, text: 'hi', color: 'var(--x)' }).catch(() => undefined);
    const text = await ok('add_text', { deckId, slideId: firstSlide, text: 'hi' });
    await ok('update_element', { deckId, elementId: text.id, changes: { color: 'rebeccapurple' } });
    const session = workspace.get(deckId);
    session.apply('bg', new (await import('../src/app/core/store/commands')).SetSlideBackground(firstSlide, { kind: 'gradient', angle: 0, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }));
    const result = await ok('check_accessibility', { deckId });
    expect(result.notChecked[0]).toMatch(/was not checked/);
  });
});

describe('describe_schema', () => {
  it.each(['overview', 'elements', 'layouts', 'themes', 'component-api', 'limits'])('answers topic %s', async (topic) => {
    expect(await ok('describe_schema', { topic })).toBeTruthy();
  });

  it('documents the component API and the element types', async () => {
    expect((await ok('describe_schema', { topic: 'component-api' })).js.join('\n')).toMatch(/deck\.ready/);
    expect(Object.keys(await ok('describe_schema', { topic: 'elements' }))).toContain('code');
    expect((await ok('describe_schema', { topic: 'layouts' })).map((l: { id: string }) => l.id)).toContain('ly_title');
  });
});
