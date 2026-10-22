import { TestBed } from '@angular/core/testing';
import { createDeck, type ComponentDef, type Deck } from '../../core/model';
import { DeckRepository, InMemoryDeckRepository, componentHash, pendingRecord, snapshotOf } from '../../core/persistence';
import { TrustStore } from './trust-store';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve));

const def = (id: string, over: Partial<ComponentDef> = {}): ComponentDef => ({ id, name: id, html: '', css: '', js: `// ${id}`, propSchema: [], permissions: [], files: [], libs: [], ...over });

function setup(withRepository = true) {
  const repo = new InMemoryDeckRepository(() => 1_000);
  TestBed.configureTestingModule({ providers: withRepository ? [{ provide: DeckRepository, useValue: repo }] : [] });
  const deck: Deck = { ...createDeck('Foreign'), components: [def('cmp_a'), def('cmp_b')] };
  return { repo, deck, trust: TestBed.inject(TrustStore) };
}

describe('TrustStore', () => {
  describe('without a repository', () => {
    it('lets everything run and asks nothing (tests and tools that store nothing)', async () => {
      const { deck, trust } = setup(false);
      expect(trust.mayRun(deck.id, deck.components[0])).toBe(true);
      expect(trust.needsReview(deck.id, deck.components)).toBe(false);
      expect(await trust.decide(deck, { run: new Set() })).toEqual({ ok: true, value: undefined });
      await trust.refresh(deck.id);
    });
  });

  describe('reading', () => {
    it('answers "no" until the record is known, and reads it by itself the first time it is asked', async () => {
      const { repo, deck, trust } = setup();
      await repo.putTrust(pendingRecord(deck.id, deck.id, 'h', null));
      expect(trust.record(deck.id)).toBeUndefined();
      expect(trust.mayRun(deck.id, deck.components[0])).toBe(false);
      await tick();
      expect(trust.record(deck.id)?.status).toBe('pending');
      expect(trust.mayRun(deck.id, deck.components[0])).toBe(false);
    });

    it('reads a deck only once, and again on refresh', async () => {
      const { repo, deck, trust } = setup();
      const get = vi.spyOn(repo, 'getTrust');
      await trust.refresh(deck.id);
      trust.mayRun(deck.id, deck.components[0]);
      trust.needsReview(deck.id, deck.components);
      await tick();
      expect(get).toHaveBeenCalledTimes(1);
      await trust.refresh(deck.id);
      expect(get).toHaveBeenCalledTimes(2);
    });

    it('shares one read between callers that ask at the same time', async () => {
      const { repo, deck, trust } = setup();
      const get = vi.spyOn(repo, 'getTrust');
      trust.mayRun(deck.id, deck.components[0]);
      trust.mayRun(deck.id, deck.components[1]);
      trust.needsReview(deck.id, deck.components);
      await tick();
      expect(get).toHaveBeenCalledTimes(1);
    });

    it('picks up a record written after the first read when the deck is opened again (a deck deleted and imported under the same id)', async () => {
      const { repo, deck, trust } = setup();
      await trust.refresh(deck.id);
      expect(trust.record(deck.id)).toBeNull();
      expect(trust.mayRun(deck.id, deck.components[0])).toBe(true);
      await repo.putTrust(pendingRecord(deck.id, deck.id, 'h', null));
      await trust.refresh(deck.id);
      expect(trust.mayRun(deck.id, deck.components[0])).toBe(false);
    });

    it('lets the newest read win when an older one finishes last', async () => {
      const { repo, deck, trust } = setup();
      const answers: ((v: unknown) => void)[] = [];
      vi.spyOn(repo, 'getTrust').mockImplementation(() => new Promise((resolve) => answers.push(resolve as (v: unknown) => void)));
      const first = trust.refresh(deck.id);
      const second = trust.refresh(deck.id);
      answers[1]({ ok: true, value: null });
      await second;
      answers[0]({ ok: true, value: pendingRecord(deck.id, deck.id, 'old', null) });
      await first;
      expect(trust.record(deck.id)).toBeNull();
    });

    it('treats a read that throws as pending', async () => {
      const { repo, deck, trust } = setup();
      vi.spyOn(repo, 'getTrust').mockRejectedValue(new Error('gone'));
      await trust.refresh(deck.id);
      expect(trust.record(deck.id)?.status).toBe('pending');
      expect(trust.mayRun(deck.id, deck.components[0])).toBe(false);
    });
  });

  describe('deciding', () => {
    it('stores one decision per component, bound to its hash, and the sources of those that run', async () => {
      const { repo, deck, trust } = setup();
      await repo.putTrust(pendingRecord(deck.id, 'dk_src', 'archive', null));
      await trust.refresh(deck.id);
      expect(await trust.decide(deck, { run: new Set(['cmp_b']) }, 7_000)).toEqual({ ok: true, value: undefined });
      const stored = await repo.getTrust(deck.id);
      expect(stored.ok && stored.value).toEqual({
        deckId: deck.id,
        sourceId: 'dk_src',
        status: 'decided',
        archiveHash: 'archive',
        decidedAt: 7_000,
        decisions: [
          { componentId: 'cmp_a', hash: await componentHash(deck.components[0]), run: false },
          { componentId: 'cmp_b', hash: await componentHash(deck.components[1]), run: true },
        ],
        snapshots: [snapshotOf(deck.components[1])],
        previous: null,
      });
      expect(trust.record(deck.id)).toEqual(stored.ok && stored.value);
    });

    it('refuses an id the deck does not have, and writes nothing', async () => {
      const { repo, deck, trust } = setup();
      await repo.putTrust(pendingRecord(deck.id, deck.id, 'h', null));
      const put = vi.spyOn(repo, 'putTrust');
      const result = await trust.decide(deck, { run: new Set(['cmp_nope']) });
      expect(result).toEqual({ ok: false, error: 'The deck has no component "cmp_nope".' });
      expect(put).not.toHaveBeenCalled();
      expect(trust.record(deck.id)?.status).toBe('pending');
    });

    it('leaves the answer as it was when storing fails', async () => {
      const { repo, deck, trust } = setup();
      await repo.putTrust(pendingRecord(deck.id, deck.id, 'h', null));
      await trust.refresh(deck.id);
      vi.spyOn(repo, 'putTrust').mockResolvedValueOnce({ ok: false, error: { kind: 'storage', message: 'closed' } });
      expect(await trust.decide(deck, { run: new Set(['cmp_a']) })).toEqual({ ok: false, error: 'Could not save your decision: closed' });
      expect(trust.record(deck.id)?.status).toBe('pending');
      expect(trust.mayRun(deck.id, deck.components[0])).toBe(false);
    });

    it('decides for a deck that has no record yet (reviewing a deck made here)', async () => {
      const { repo, deck, trust } = setup();
      expect(await trust.decide(deck, { run: new Set(['cmp_a']) })).toEqual({ ok: true, value: undefined });
      const stored = await repo.getTrust(deck.id);
      expect(stored.ok && stored.value?.status).toBe('decided');
    });

    it('lets the user change their mind: a later decision replaces the earlier one', async () => {
      const { repo, deck, trust } = setup();
      await repo.putTrust(pendingRecord(deck.id, deck.id, 'h', null));
      await trust.decide(deck, { run: new Set(['cmp_a', 'cmp_b']) });
      await tick();
      expect(deck.components.map((c) => trust.mayRun(deck.id, c))).toEqual([true, true]);
      await trust.decide(deck, { run: new Set(['cmp_a']) });
      expect(deck.components.map((c) => trust.mayRun(deck.id, c))).toEqual([true, false]);
    });
  });

  describe('which decision still holds', () => {
    async function decided(run: string[]) {
      const ctx = setup();
      await ctx.repo.putTrust(pendingRecord(ctx.deck.id, ctx.deck.id, 'h', null));
      await ctx.trust.decide(ctx.deck, { run: new Set(run) });
      return ctx;
    }

    it('runs a component only while its definition is the one that was decided', async () => {
      const { deck, trust } = await decided(['cmp_a']);
      const same = { ...deck.components[0] }; // a new object with the same content
      expect(trust.mayRun(deck.id, same)).toBe(false); // its hash is still being taken
      await tick();
      expect(trust.mayRun(deck.id, same)).toBe(true);
      const changed = { ...deck.components[0], js: 'steal()' };
      trust.mayRun(deck.id, changed);
      await tick();
      expect(trust.mayRun(deck.id, changed)).toBe(false);
    });

    it('asks again for a changed or new component, and not for one that was kept off', async () => {
      const { deck, trust } = await decided(['cmp_a']);
      await tick();
      expect(trust.needsReview(deck.id, deck.components)).toBe(false); // a was run, b was kept off: both decided
      const changed = [{ ...deck.components[0], css: 'p{}' }, deck.components[1]];
      trust.needsReview(deck.id, changed);
      await tick();
      expect(trust.needsReview(deck.id, changed)).toBe(true);
      const added = [...deck.components, def('cmp_new')];
      trust.needsReview(deck.id, added);
      await tick();
      expect(trust.needsReview(deck.id, added)).toBe(true);
    });

    it('does not ask about a deck without a record', async () => {
      const { deck, trust } = setup();
      await trust.refresh(deck.id);
      expect(trust.needsReview(deck.id, deck.components)).toBe(false);
    });

    it('does not ask about a pending deck that has no components, and asks when it has some', async () => {
      const { repo, deck, trust } = setup();
      await repo.putTrust(pendingRecord(deck.id, deck.id, 'h', null));
      await trust.refresh(deck.id);
      expect(trust.needsReview(deck.id, [])).toBe(false);
      expect(trust.needsReview(deck.id, deck.components)).toBe(true);
    });

    it('stops everything again when the decision is "nothing runs"', async () => {
      const { deck, trust } = await decided([]);
      await tick();
      expect(deck.components.some((c) => trust.mayRun(deck.id, c))).toBe(false);
      expect(trust.needsReview(deck.id, deck.components)).toBe(false);
    });
  });

  describe('diffBase', () => {
    it('is the earlier trusted version while the deck is pending, and what was trusted after a decision', async () => {
      const { repo, deck, trust } = setup();
      const earlier = [snapshotOf(def('cmp_a', { js: 'old' }))];
      await repo.putTrust(pendingRecord(deck.id, 'dk_src', 'h', earlier));
      await trust.refresh(deck.id);
      expect(trust.diffBase(deck.id)).toEqual(earlier);
      await trust.decide(deck, { run: new Set(['cmp_b']) });
      expect(trust.diffBase(deck.id)).toEqual([snapshotOf(deck.components[1])]);
    });

    it('falls back to the earlier version when the decision ran nothing, and is empty for a deck without a record', async () => {
      const { repo, deck, trust } = setup();
      const earlier = [snapshotOf(def('cmp_a', { js: 'old' }))];
      await repo.putTrust(pendingRecord(deck.id, 'dk_src', 'h', earlier));
      await trust.refresh(deck.id);
      await trust.decide(deck, { run: new Set() });
      expect(trust.diffBase(deck.id)).toEqual(earlier);
      expect(trust.diffBase('dk_unknown')).toEqual([]);
    });
  });

  describe('knownLibraries', () => {
    it('collects the library files of everything the user chose to run, in any deck', async () => {
      const { repo, trust } = setup();
      const lib = 'e'.repeat(64);
      await repo.putTrust({ ...pendingRecord('dk_1', 'dk_1', 'h', null), status: 'decided', decidedAt: 1, snapshots: [snapshotOf(def('cmp_a', { libs: [lib] }))] });
      await repo.putTrust(pendingRecord('dk_2', 'dk_2', 'h', [snapshotOf(def('cmp_b', { libs: ['f'.repeat(64)] }))]));
      expect([...(await trust.knownLibraries())]).toEqual([lib]);
    });

    it('is empty without a repository', async () => {
      const { trust } = setup(false);
      expect((await trust.knownLibraries()).size).toBe(0);
    });
  });
});
