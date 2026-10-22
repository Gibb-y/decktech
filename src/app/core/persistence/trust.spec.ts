import type { ComponentDef } from '../model';
import { canonicalJson, componentHash, pendingRecord, previousSnapshots, readTrustRecord, snapshotOf, trustOrPending, type TrustRecord } from './trust';

const DEF: ComponentDef = { id: 'cmp_a', name: 'A', html: '<p>x</p>', css: '', js: 'deck.ready(() => {})', propSchema: [], permissions: [], files: [], libs: [] };

const decided = (deckId: string, sourceId: string, at: number, defs: ComponentDef[]): TrustRecord => ({
  ...pendingRecord(deckId, sourceId, 'h', null),
  status: 'decided',
  decidedAt: at,
  snapshots: defs.map(snapshotOf),
});

describe('canonicalJson', () => {
  it('does not depend on the order of keys, at any depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }));
  });

  it('tells arrays, strings and numbers apart', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson('1')).not.toBe(canonicalJson(1));
  });
});

describe('componentHash', () => {
  it('is a SHA-256 digest that follows every part of the definition', async () => {
    const base = await componentHash(DEF);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await componentHash({ ...DEF, id: DEF.id })).toBe(base);
    const changes: Partial<ComponentDef>[] = [{ name: 'B' }, { html: '<p>y</p>' }, { css: 'p{}' }, { js: 'alert(1)' }, { permissions: ['network'] }, { libs: ['a'.repeat(64)] }, { files: ['b'.repeat(64)] }, { propSchema: [{ key: 'k', label: 'K', type: 'string', default: '' }] }];
    for (const change of changes) expect(await componentHash({ ...DEF, ...change })).not.toBe(base);
  });

  it('does not depend on the order of keys of the definition', async () => {
    const shuffled = Object.fromEntries(Object.entries(DEF).reverse()) as unknown as ComponentDef;
    expect(await componentHash(shuffled)).toBe(await componentHash(DEF));
  });
});

describe('snapshotOf', () => {
  it('copies the reviewable sources, with the schema as formatted text', () => {
    const shot = snapshotOf({ ...DEF, permissions: ['network'], libs: ['l'] });
    expect(shot).toMatchObject({ componentId: 'cmp_a', name: 'A', html: '<p>x</p>', props: '[]', permissions: ['network'], libs: ['l'] });
  });

  it('does not share its lists with the definition', () => {
    const def = { ...DEF, libs: ['l'] };
    const shot = snapshotOf(def);
    shot.libs.push('m');
    expect(def.libs).toEqual(['l']);
  });
});

describe('readTrustRecord', () => {
  it('accepts a record and returns a copy', () => {
    const record = decided('dk_1', 'dk_1', 5, [DEF]);
    const read = readTrustRecord(record);
    expect(read).toEqual(record);
    expect(read).not.toBe(record);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'trusted'],
    ['a missing deck id', { ...pendingRecord('x', 'x', '', null), deckId: undefined }],
    ['an unknown status', { ...pendingRecord('x', 'x', '', null), status: 'ok' }],
    ['decisions that are not a list', { ...pendingRecord('x', 'x', '', null), decisions: {} }],
    ['a decision whose run is not a boolean', { ...pendingRecord('x', 'x', '', null), decisions: [{ componentId: 'c', hash: 'h', run: 'yes' }] }],
    ['a previous that is not a list', { ...pendingRecord('x', 'x', '', null), previous: 'no' }],
    ['a snapshot with a number for its html', { ...pendingRecord('x', 'x', '', null), snapshots: [{ ...snapshotOf(DEF), html: 1 }] }],
  ])('refuses %s', (_name, value) => {
    expect(readTrustRecord(value)).toBeNull();
  });
});

describe('trustOrPending', () => {
  it('turns a damaged record into a pending one, never into "no record" (which would mean trusted)', () => {
    const record = trustOrPending('dk_9', { status: 'decided', decisions: 'all' });
    expect(record).toMatchObject({ deckId: 'dk_9', status: 'pending', decisions: [] });
  });

  it('keeps a good record', () => {
    const record = decided('dk_1', 'dk_1', 5, [DEF]);
    expect(trustOrPending('dk_1', record)).toEqual(record);
  });
});

describe('previousSnapshots', () => {
  it('takes the latest decision about the same source deck that ran something', () => {
    const older = decided('dk_old', 'dk_src', 10, [DEF]);
    const newer = decided('dk_new', 'dk_src', 20, [{ ...DEF, js: 'v2' }]);
    const other = decided('dk_other', 'dk_else', 30, [{ ...DEF, js: 'other' }]);
    expect(previousSnapshots([older, newer, other], 'dk_src')?.[0].js).toBe('v2');
  });

  it('ignores pending records and decisions that ran nothing', () => {
    const pending = pendingRecord('dk_p', 'dk_src', 'h', null);
    const nothingRan = decided('dk_n', 'dk_src', 5, []);
    expect(previousSnapshots([pending, nothingRan], 'dk_src')).toBeNull();
    expect(previousSnapshots([], 'dk_src')).toBeNull();
  });

  it('returns a copy', () => {
    const record = decided('dk_1', 'dk_src', 5, [DEF]);
    const snapshots = previousSnapshots([record], 'dk_src')!;
    snapshots[0].js = 'changed';
    expect(record.snapshots[0].js).toBe(DEF.js);
  });
});
