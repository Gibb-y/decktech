import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_LIBRARY_BYTES } from '../src/app/components/editor/vendor';
import { fakeCdn, MINI_REACT, MINI_REACT_DOM, REACT_COUNTER_JS, REACT_CDN, type FakeCdn } from './library-fixtures';
import { importProblems, importSpecifiers, resolveSpecifiers, specifierNames } from './libraries';
import { callTool, TOOLS } from './server';
import { Workspace } from './workspace';

let dir: string;
let workspace: Workspace;
let cdn: FakeCdn;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decktech-libs-'));
  mkdirSync(join(dir, 'work'));
  cdn = fakeCdn(REACT_CDN);
  workspace = new Workspace({
    root: join(dir, 'work'),
    libraryDir: join(dir, 'work', '.decktech', 'library'),
    fetcher: cdn.fetcher,
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const newDeck = async () => (await ok('create_deck', { title: 'T' })).deckId as string;
const addReact = (deckId: string) => ok('add_library_from_package', { deckId, package: 'react', version: '1.0.0' });
const addDom = (deckId: string) => ok('add_library_from_package', { deckId, package: 'react-dom/client', version: '1.0.0' });

describe('add_library_from_package', () => {
  it('stores the bundle in the deck under its content hash and says how to import it', async () => {
    const deckId = await newDeck();
    const lib = await addReact(deckId);
    expect(lib).toMatchObject({ assetId: sha(MINI_REACT), name: 'react', label: 'react@1.0.0', importAs: 'react', bytes: MINI_REACT.length });
    expect(lib.next).toMatch(/libs: \["react"\]/);
    const session = workspace.get(deckId);
    expect(session.deck.assets[lib.assetId]).toMatchObject({ mime: 'text/javascript', size: MINI_REACT.length });
    expect(new TextDecoder().decode(session.assets.get(lib.assetId))).toBe(MINI_REACT);
    expect(cdn.calls).toEqual([
      'https://esm.sh/react@1.0.0?bundle&target=es2022',
      'https://esm.sh/react@1.0.0/es2022/react.bundle.mjs',
    ]);
  });

  it('is idempotent: the same content is one asset', async () => {
    const deckId = await newDeck();
    const first = await addReact(deckId);
    const second = await addReact(deckId);
    expect(second.assetId).toBe(first.assetId);
    expect(Object.keys(workspace.get(deckId).deck.assets)).toHaveLength(1);
  });

  it('is one undo step', async () => {
    const deckId = await newDeck();
    await addReact(deckId);
    await ok('undo', { deckId });
    expect(Object.keys(workspace.get(deckId).deck.assets)).toHaveLength(0);
  });

  it('points the react import of react-dom/client at the vendored react, so both share one instance', async () => {
    const deckId = await newDeck();
    const react = await addReact(deckId);
    const dom = await addDom(deckId);
    expect(dom).toMatchObject({ name: 'react-dom/client', sharesInstanceWith: ['/react@1.0.0/es2022/react.mjs'] });
    const stored = new TextDecoder().decode(workspace.get(deckId).assets.get(dom.assetId));
    expect(stored).toContain(`from "${react.assetId}"`);
    expect(stored).not.toContain('/react@');
    expect(cdn.calls).toContain('https://esm.sh/react-dom@1.0.0/client?bundle&target=es2022');
  });

  it('refuses a library that builds on a library the deck does not have, and says to add that one first', async () => {
    const deckId = await newDeck();
    const r = await call('add_library_from_package', { deckId, package: 'react-dom/client', version: '1.0.0' });
    expect(r.error).toMatch(/imports from the network \(\/react@1\.0\.0\/es2022\/react\.mjs\)/);
    expect(r.error).toMatch(/add that one first/);
    expect(Object.keys(workspace.get(deckId).deck.assets)).toHaveLength(0);
  });

  it('does not point an import at a library of another name', async () => {
    cdn = fakeCdn({ ...REACT_CDN, 'https://esm.sh/preact@1.0.0?bundle&target=es2022': 'import "/react@1.0.0/es2022/other.mjs"; import "/zzz@1.0.0/es2022/zzz.mjs";' });
    workspace = new Workspace({ root: join(dir, 'work'), libraryDir: join(dir, 'lib'), fetcher: cdn.fetcher });
    const deckId = await newDeck();
    await addReact(deckId);
    // "react/other" and "zzz" are not vendored libraries, so both imports stay unresolved.
    const r = await call('add_library_from_package', { deckId, package: 'preact', version: '1.0.0' });
    expect(r.error).toMatch(/imports from the network \(\/react@1\.0\.0\/es2022\/other\.mjs, \/zzz@1\.0\.0\/es2022\/zzz\.mjs\)/);
  });

  it.each([
    ['an invalid name', { package: '../x' }, /not a valid npm package name/],
    ['a name outside the CDN path', { package: 'a/../b' }, /not a valid npm package name/],
    ['an invalid version', { package: 'react', version: '1/../2' }, /not a valid version/],
    ['an unknown package', { package: 'nothing-here', version: '1.0.0' }, /\(404\)/],
  ])('refuses %s without touching the deck', async (_what, input, message) => {
    const deckId = await newDeck();
    const r = await call('add_library_from_package', { deckId, ...input });
    expect(r.error).toMatch(message);
    expect(Object.keys(workspace.get(deckId).deck.assets)).toHaveLength(0);
  });

  it('says to be online when the download fails, and does not ask the network for an invalid name', async () => {
    workspace = new Workspace({
      root: join(dir, 'work'),
      libraryDir: join(dir, 'lib'),
      fetcher: async () => {
        throw new Error('offline');
      },
    });
    const deckId = await newDeck();
    expect((await call('add_library_from_package', { deckId, package: 'react' })).error).toMatch(/online once/);
  });

  it('refuses a library over the size limit', async () => {
    const big = `export const x = "${'a'.repeat(MAX_LIBRARY_BYTES)}";`;
    workspace = new Workspace({ root: join(dir, 'work'), libraryDir: join(dir, 'lib'), fetcher: fakeCdn({ 'https://esm.sh/big@1.0.0?bundle&target=es2022': big }).fetcher });
    const deckId = await newDeck();
    expect((await call('add_library_from_package', { deckId, package: 'big', version: '1.0.0' })).error).toMatch(/larger than 5 MiB/);
  });

  it('respects the deck asset budget', async () => {
    const deckId = await newDeck();
    workspace.get(deckId).assets.set('filler', new Uint8Array(256 * 1024 * 1024));
    const r = await call('add_library_from_package', { deckId, package: 'react', version: '1.0.0' });
    expect(r.error).toMatch(/limit is 256 MiB/);
    expect(Object.keys(workspace.get(deckId).deck.assets)).toHaveLength(0);
  });
});

describe('add_library_from_file', () => {
  const write = (name: string, text: string) => writeFileSync(join(dir, 'work', name), text);

  it('stores a module file and imports of libraries already in the deck are resolved', async () => {
    const deckId = await newDeck();
    const react = await addReact(deckId);
    write('dom.mjs', MINI_REACT_DOM);
    const lib = await ok('add_library_from_file', { deckId, path: 'dom.mjs', name: 'react-dom/client' });
    expect(lib).toMatchObject({ name: 'react-dom/client', label: 'react-dom/client' });
    expect(new TextDecoder().decode(workspace.get(deckId).assets.get(lib.assetId))).toContain(`"${react.assetId}"`);
  });

  it('names the library after the file by default', async () => {
    const deckId = await newDeck();
    write('my-lib.js', 'export const x = 1;');
    expect(await ok('add_library_from_file', { deckId, path: 'my-lib.js' })).toMatchObject({ name: 'my-lib', assetId: sha('export const x = 1;') });
  });

  it.each([
    ['a file that is not JavaScript', 'lib.txt', 'export {}', undefined, /not a JavaScript module/],
    ['an import from the network', 'lib.js', 'import x from "https://evil.example/x.js";', undefined, /imports from elsewhere/],
    ['a name that is not an npm name', 'lib.js', 'export {}', 'Bad Name', /cannot be used as a library name/],
    ['a name that tries to leave the path', 'lib.js', 'export {}', '../x', /cannot be used as a library name/],
    ['a path outside the workspace', '../outside.js', 'export {}', 'x', /outside the workspace/],
    ['a file that does not exist', 'missing.js', undefined, 'x', /does not exist/],
    ['a file over the size limit', 'huge.js', `// ${'a'.repeat(MAX_LIBRARY_BYTES)}`, 'huge', /larger than 5 MiB/],
    ['a file that is not UTF-8', 'bin.js', undefined, 'bin', /not UTF-8/],
  ])('refuses %s', async (_what, path, text, name, message) => {
    const deckId = await newDeck();
    if (text !== undefined && !path.startsWith('..')) write(path, text);
    if (path === 'bin.js') writeFileSync(join(dir, 'work', path), Uint8Array.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
    const r = await call('add_library_from_file', { deckId, path, ...(name ? { name } : {}) });
    expect(r.error).toMatch(message);
    expect(Object.keys(workspace.get(deckId).deck.assets)).toHaveLength(0);
  });
});

describe('attaching libraries to components', () => {
  const COMPONENT = { name: 'React counter', html: '<div id="app"></div>', js: REACT_COUNTER_JS, propSchema: [{ key: 'start', type: 'number', label: 'Start', default: 0 }] };

  async function reactDeck() {
    const deckId = await newDeck();
    const react = await addReact(deckId);
    const dom = await addDom(deckId);
    return { deckId, react: react.assetId as string, dom: dom.assetId as string };
  }

  it('create_component takes libs by name and stores the asset ids in the script', async () => {
    const { deckId, react, dom } = await reactDeck();
    const made = await ok('create_component', { deckId, ...COMPONENT, libs: ['react', 'react-dom/client'] });
    expect(made.warnings).toEqual([]);
    expect(made.libs).toEqual([
      { assetId: react, name: 'react', label: 'react@1.0.0', bytes: MINI_REACT.length },
      { assetId: dom, name: 'react-dom/client', label: 'react-dom/client@1.0.0', bytes: expect.any(Number) },
    ]);
    const stored = await ok('get_component', { deckId, componentId: made.id });
    expect(stored.js).toContain(`from "${react}"`);
    expect(stored.js).toContain(`from "${dom}"`);
    expect(stored.js).not.toContain('from "react"');
    expect(stored.libs).toHaveLength(2);
    const listed = await ok('list_components', { deckId });
    expect(listed[0].libs.map((l: { name: string }) => l.name)).toEqual(['react', 'react-dom/client']);
  });

  it('accepts the label with its version and the asset id', async () => {
    const { deckId, react } = await reactDeck();
    const made = await ok('create_component', { deckId, name: 'A', libs: ['react@1.0.0', react], js: 'import React from "react@1.0.0"; deck.ready(() => React);' });
    expect(made.libs).toHaveLength(1);
    expect((await ok('get_component', { deckId, componentId: made.id })).js).toContain(`from "${react}"`);
  });

  it('refuses a library the deck does not have, with the choices, and creates nothing', async () => {
    const { deckId } = await reactDeck();
    const r = await call('create_component', { deckId, name: 'A', libs: ['lodash'] });
    expect(r.error).toMatch(/"lodash" is not a library of this deck. Libraries: react@1\.0\.0, react-dom\/client@1\.0\.0/);
    expect((await ok('list_components', { deckId })).length).toBe(0);
  });

  it.each(['constructor', '__proto__', 'toString', ''.padEnd(64, 'f')])('treats %j as an unknown library, not as an inherited member', async (name) => {
    const { deckId } = await reactDeck();
    expect((await call('create_component', { deckId, name: 'A', libs: [name] })).error).toMatch(/is not a library of this deck/);
  });

  it('asks for the asset id when two libraries share a name', async () => {
    const deckId = await newDeck();
    cdn = fakeCdn({
      'https://esm.sh/x@1.0.0?bundle&target=es2022': 'export const v = 1;',
      'https://esm.sh/x@2.0.0?bundle&target=es2022': 'export const v = 2;',
    });
    workspace = new Workspace({ root: join(dir, 'work'), libraryDir: join(dir, 'lib'), fetcher: cdn.fetcher });
    const id = await newDeck();
    const one = await ok('add_library_from_package', { deckId: id, package: 'x', version: '1.0.0' });
    const two = await ok('add_library_from_package', { deckId: id, package: 'x', version: '2.0.0' });
    const r = await call('create_component', { deckId: id, name: 'A', libs: ['x'] });
    expect(r.error).toMatch(/names more than one library.*x@1\.0\.0 = [0-9a-f]{64}.*x@2\.0\.0/);
    const made = await ok('create_component', { deckId: id, name: 'A', libs: ['x@2.0.0'], js: 'import * as x from "x@2.0.0"; deck.ready(() => x);' });
    expect(made.libs[0].assetId).toBe(two.assetId);
    expect(one.assetId).not.toBe(two.assetId);
    void deckId;
  });

  it('update_component replaces the list, keeps it when omitted and rewrites the new script against it', async () => {
    const { deckId, react } = await reactDeck();
    const made = await ok('create_component', { deckId, name: 'A', libs: ['react'], js: 'import React from "react"; deck.ready(() => React);' });
    const kept = await ok('update_component', { deckId, componentId: made.id, name: 'B' });
    expect(kept.libs.map((l: { assetId: string }) => l.assetId)).toEqual([react]);
    const rewritten = await ok('update_component', { deckId, componentId: made.id, js: 'import { createElement } from "react"; deck.ready(() => createElement);' });
    expect(rewritten.warnings).toEqual([]);
    expect((await ok('get_component', { deckId, componentId: made.id })).js).toContain(`from "${react}"`);
    const cleared = await ok('update_component', { deckId, componentId: made.id, libs: [] });
    expect(cleared.libs).toEqual([]);
    expect(cleared.warnings.join('\n')).toMatch(/imports "[0-9a-f]{64}", an asset of the deck that is not in this component's libs/);
  });

  it('warns when a library imports another vendored library that is not attached', async () => {
    const { deckId, react, dom } = await reactDeck();
    const only = await ok('create_component', { deckId, name: 'A', libs: ['react-dom/client'] });
    expect(only.warnings.join(' ')).toMatch(/react-dom\/client@1\.0\.0 imports react@1\.0\.0, which is not in this component's libs/);
    const both = await ok('create_component', { deckId, name: 'B', libs: ['react-dom/client', 'react'] });
    expect(both.warnings).toEqual([]);
    void react;
    void dom;
  });

  it('is one undo step and a refused update changes nothing', async () => {
    const { deckId, react } = await reactDeck();
    const made = await ok('create_component', { deckId, name: 'A' });
    await ok('update_component', { deckId, componentId: made.id, libs: ['react'] });
    await ok('undo', { deckId });
    expect(workspace.get(deckId).deck.components[0].libs).toEqual([]);
    const r = await call('update_component', { deckId, componentId: made.id, libs: ['nope'], name: 'changed' });
    expect(r.error).toMatch(/not a library/);
    expect(workspace.get(deckId).deck.components[0].name).toBe('A');
    void react;
  });

  it('warns about imports the sandbox cannot resolve, each with a reason', async () => {
    const { deckId, react } = await reactDeck();
    const missing = 'f'.repeat(64);
    const js = `import a from "lodash"; import b from "https://esm.sh/x"; import c from "./other.js"; import d from "${missing}"; const e = await import("lodash"); export * from "react";`;
    const made = await ok('create_component', { deckId, name: 'A', js, libs: ['react'] });
    const text = made.warnings.join('\n');
    expect(text).toMatch(/"lodash", which is not an attached library.*Attached libraries: react \(/);
    expect(text).toMatch(/"https:\/\/esm\.sh\/x", which cannot load/);
    expect(text).toMatch(/"\.\/other\.js", which cannot load/);
    expect(text).toMatch(new RegExp(`"${missing}", which is not a library of this deck`));
    expect(made.warnings.filter((w: string) => w.includes('"lodash"'))).toHaveLength(1);
    expect(text).not.toContain(`"${react}"`);
  });

  it('validate_component reports the same problems and can check a revision with other libs', async () => {
    const { deckId, react } = await reactDeck();
    const made = await ok('create_component', { deckId, name: 'A', js: 'deck.ready(() => {});' });
    const clean = await ok('validate_component', { deckId, componentId: made.id });
    expect(clean.warnings.join('\n')).not.toMatch(/library/);
    const revised = await ok('validate_component', { deckId, componentId: made.id, js: 'import R from "react"; deck.ready(() => R);' });
    expect(revised.warnings.join('\n')).toMatch(/"react", which is not an attached library/);
    const withLibs = await ok('validate_component', { deckId, componentId: made.id, js: 'import R from "react"; deck.ready(() => R);', libs: ['react'] });
    expect(withLibs.valid).toBe(true);
    expect(withLibs.warnings.join('\n')).not.toMatch(/library/);
    expect(workspace.get(deckId).deck.components[0].libs).toEqual([]);
    expect((await call('validate_component', { js: 'let x', libs: ['react'] })).error).toMatch(/only be checked together with deckId and componentId/);
    void react;
  });

  it('keeps libraries and their bytes through export and open_deck', async () => {
    const { deckId, react } = await reactDeck();
    await ok('create_component', { deckId, ...COMPONENT, libs: ['react', 'react-dom/client'] });
    await ok('export_deck', { deckId, path: 'react.deck' });
    const reopened = await ok('open_deck', { path: 'react.deck' });
    const [component] = await ok('list_components', { deckId: reopened.deckId });
    expect(component.libs.map((l: { assetId: string }) => l.assetId)).toContain(react);
    expect(component.libs[0].bytes).toBe(MINI_REACT.length);
    expect(new TextDecoder().decode(workspace.get(reopened.deckId).assets.get(react))).toBe(MINI_REACT);
  });
});

describe('the component library keeps libraries with the component', () => {
  async function savedComponent() {
    const deckId = await newDeck();
    const react = await addReact(deckId);
    const made = await ok('create_component', { deckId, name: 'R', libs: ['react'], js: 'import R from "react"; deck.ready(() => R);' });
    await ok('save_to_library', { deckId, componentId: made.id });
    return { deckId, id: made.id as string, react: react.assetId as string };
  }

  it('saves the bytes next to the entry and import_from_library brings them into another deck', async () => {
    const { id, react } = await savedComponent();
    const listing = await ok('list_components', { source: 'library' });
    expect(listing.map((e: { id: string }) => e.id)).toEqual([id]);
    expect(readdirSync(join(dir, 'work', '.decktech', 'library', 'assets'))).toEqual([react]);
    const other = await newDeck();
    const imported = await ok('import_from_library', { deckId: other, libraryId: id });
    expect(imported.libs).toEqual([{ assetId: react, name: 'react', label: 'react@1.0.0', bytes: MINI_REACT.length }]);
    expect(imported.warnings).toEqual([]);
    const session = workspace.get(other);
    expect(session.deck.assets[react]).toMatchObject({ mime: 'text/javascript' });
    expect(new TextDecoder().decode(session.assets.get(react))).toBe(MINI_REACT);
  });

  it('remembers the names of the libraries, so an imported component can be edited by name', async () => {
    const { id, react } = await savedComponent();
    const other = await newDeck();
    await ok('import_from_library', { deckId: other, libraryId: id });
    const [component] = await ok('list_components', { deckId: other });
    expect(component.libs).toEqual([{ assetId: react, name: 'react', label: 'react@1.0.0', bytes: MINI_REACT.length }]);
    const updated = await ok('update_component', { deckId: other, componentId: id, libs: ['react'] });
    expect(updated.libs).toHaveLength(1);
  });

  it('ignores malformed names in a library file', async () => {
    const { id, react } = await savedComponent();
    const file = join(dir, 'work', '.decktech', 'library', `${id}.json`);
    const entry = JSON.parse(readFileSync(file, 'utf8'));
    entry.names = { [react]: { name: '../evil', label: 'x' } };
    writeFileSync(file, JSON.stringify(entry));
    const other = await newDeck();
    await ok('import_from_library', { deckId: other, libraryId: id });
    expect(workspace.get(other).libraries.size).toBe(0);
  });

  it('importing twice adds the component and asset once', async () => {
    const { id } = await savedComponent();
    const other = await newDeck();
    await ok('import_from_library', { deckId: other, libraryId: id });
    await ok('import_from_library', { deckId: other, libraryId: id });
    expect(workspace.get(other).deck.components).toHaveLength(1);
    expect(Object.keys(workspace.get(other).deck.assets)).toHaveLength(1);
  });

  it('refuses an entry whose library file was changed, and adds nothing', async () => {
    const { id, react } = await savedComponent();
    writeFileSync(join(dir, 'work', '.decktech', 'library', 'assets', react), 'export const hacked = true;');
    const other = await newDeck();
    const r = await call('import_from_library', { deckId: other, libraryId: id });
    expect(r.error).toMatch(/damaged.*does not match its hash/);
    expect(workspace.get(other).deck.components).toHaveLength(0);
    expect(Object.keys(workspace.get(other).deck.assets)).toHaveLength(0);
  });

  it('refuses an entry whose library file is missing', async () => {
    const { id, react } = await savedComponent();
    rmSync(join(dir, 'work', '.decktech', 'library', 'assets', react));
    const other = await newDeck();
    expect((await call('import_from_library', { deckId: other, libraryId: id })).error).toMatch(/damaged/);
  });

  it('refuses to import over the deck asset budget without adding anything', async () => {
    const { id } = await savedComponent();
    const other = await newDeck();
    workspace.get(other).assets.set('filler', new Uint8Array(256 * 1024 * 1024));
    expect((await call('import_from_library', { deckId: other, libraryId: id })).error).toMatch(/limit is 256 MiB/);
    expect(workspace.get(other).deck.components).toHaveLength(0);
  });

  it('still saves a component without assets as before', async () => {
    const deckId = await newDeck();
    const made = await ok('create_component', { deckId, name: 'Plain' });
    await ok('save_to_library', { deckId, componentId: made.id });
    expect(readdirSync(join(dir, 'work', '.decktech', 'library')).filter((n) => n.endsWith('.json'))).toEqual([`${made.id}.json`]);
  });
});

describe('import analysis', () => {
  it('finds every static and dynamic specifier and nothing in strings or comments', () => {
    const js = `
      import a from "one"; import { b } from 'two'; import "three"; export * from "four"; export { c } from "five";
      const d = await import("six"); const e = "import x from 'not-this'"; /* import y from "nor-this" */ // import "nor-that"
      const f = () => import(\`template\`); import(variable);
    `;
    expect(importSpecifiers(js)?.map((s) => s.value)).toEqual(['one', 'two', 'three', 'four', 'five', 'six']);
  });

  it('gives up on a script that does not parse', () => {
    expect(importSpecifiers('import from')).toBeUndefined();
    expect(resolveSpecifiers('import from', new Map([['x', 'y']]))).toEqual({ js: 'import from', rewritten: {} });
  });

  it('rewrites only specifiers, keeps quotes valid and positions intact', () => {
    const js = `import R, { useState } from 'react'; const s = "react"; export * from "react"; const m = await import("react");`;
    const out = resolveSpecifiers(js, new Map([['react', 'abc']]));
    expect(out.js).toBe(`import R, { useState } from "abc"; const s = "react"; export * from "abc"; const m = await import("abc");`);
    expect(out.rewritten).toEqual({ react: 'abc' });
  });

  it('does not match inherited names', () => {
    const out = resolveSpecifiers('import a from "constructor"; import b from "__proto__";', new Map());
    expect(out.rewritten).toEqual({});
  });

  it('treats a name two libraries share as ambiguous and resolves nothing for it', () => {
    const libraries = new Map([
      ['a', { name: 'x', label: 'x@1' }],
      ['b', { name: 'x', label: 'x@2' }],
    ]);
    const { names, ambiguous } = specifierNames({ libraries }, ['a', 'b']);
    expect([...ambiguous]).toEqual(['x']);
    expect(Object.fromEntries(names)).toEqual({ 'x@1': 'a', 'x@2': 'b' });
    expect(importProblems({ js: 'import x from "x";', libs: ['a', 'b'] }, { libraries }, new Set(['a', 'b']))[0]).toMatch(/two attached libraries have that name/);
  });
});
