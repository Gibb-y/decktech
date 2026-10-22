import { Service, inject, signal, type Signal, type WritableSignal } from '@angular/core';
import { err, ok, type ComponentDef, type Deck, type Result } from '../../core/model';
import { DeckRepository, componentHash, pendingRecord, snapshotOf, type ComponentSnapshot, type TrustRecord } from '../../core/persistence';

/** What the user chose for each component of a deck: the ids to run; every other component stays off. */
export interface TrustChoice {
  run: ReadonlySet<string>;
}

/**
 * The user's trust decisions for the code in decks (arc42 §6.4, ADR-008), as the code host needs
 * them: synchronous, reactive answers to "may this component run?".
 *
 * Fail closed: a deck whose record has not been read yet, whose record could not be read, or whose
 * record is pending answers no. A deck without a record was made here and is trusted. Decisions are
 * bound to the hash of the component definition they were made for, so editing a component (or an
 * imported deck coming back with changed code) leaves it undecided. Without a `DeckRepository`
 * (tests, tools) nothing is recorded anywhere and everything runs.
 */
@Service()
export class TrustStore {
  private readonly repository = inject(DeckRepository, { optional: true });
  private readonly records = signal<ReadonlyMap<string, TrustRecord | null>>(new Map());
  private readonly reading = new Map<string, Promise<void>>();
  /** Identifies the newest read of each deck; an older read that finishes later is dropped. */
  private readonly tokens = new Map<string, object>();
  private readonly hashes = new WeakMap<ComponentDef, WritableSignal<string | null>>();

  /** The record read for a deck: `null` when it has none (trusted), `undefined` while it has not been read. */
  record(deckId: string): TrustRecord | null | undefined {
    return this.records().get(deckId);
  }

  /** Reads the record again, so that a deck opened now is judged by what is stored now. */
  refresh(deckId: string): Promise<void> {
    return this.read(deckId, true);
  }

  /** Whether a frame may be made for the component. Starts reading the record and the hash when they are not known yet. */
  mayRun(deckId: string, def: ComponentDef): boolean {
    if (!this.repository) return true;
    const record = this.record(deckId);
    if (record === undefined) {
      void this.read(deckId, false);
      return false;
    }
    if (record === null) return true;
    const hash = this.hashOf(def)();
    if (hash === null) return false;
    return record.decisions.some((d) => d.componentId === def.id && d.hash === hash && d.run);
  }

  /**
   * Whether the user still has something to decide: the deck is pending, or a component has no
   * decision for its current content (new, or changed since). False while that is not known yet.
   */
  needsReview(deckId: string, components: readonly ComponentDef[]): boolean {
    if (!this.repository) return false;
    const record = this.record(deckId);
    if (record === undefined) {
      void this.read(deckId, false);
      return false;
    }
    if (record === null || components.length === 0) return false;
    if (record.status === 'pending') return true;
    return components.some((def) => {
      const hash = this.hashOf(def)();
      return hash !== null && !record.decisions.some((d) => d.componentId === def.id && d.hash === hash);
    });
  }

  /** The sources the user last trusted (or, for a fresh import, those of an earlier version) to compare against. */
  diffBase(deckId: string): ComponentSnapshot[] {
    const record = this.record(deckId);
    if (!record) return [];
    return record.status === 'decided' && record.snapshots.length > 0 ? record.snapshots : (record.previous ?? []);
  }

  /** Digests of library files in components the user chose to run, for the "known library" mark. */
  async knownLibraries(): Promise<Set<string>> {
    const known = new Set<string>();
    const all = await this.repository?.listTrust();
    if (all?.ok) for (const record of all.value) for (const snapshot of record.snapshots) for (const id of snapshot.libs) known.add(id);
    return known;
  }

  /**
   * Records the decision for a whole deck: the components in `choice.run` may run, the others are
   * recorded as kept off. Hashes are taken first and the record is written once, so a failure
   * changes nothing.
   */
  async decide(deck: Deck, choice: TrustChoice, now: number = Date.now()): Promise<Result<void, string>> {
    if (!this.repository) return ok(undefined);
    const current = this.record(deck.id) ?? (await this.read(deck.id, false).then(() => this.record(deck.id)));
    const base = current ?? pendingRecord(deck.id, deck.id, '', null);
    const known = new Set(deck.components.map((def) => def.id));
    for (const id of choice.run) if (!known.has(id)) return err(`The deck has no component "${id}".`);
    let decisions: TrustRecord['decisions'];
    try {
      decisions = await Promise.all(deck.components.map(async (def) => ({ componentId: def.id, hash: await componentHash(def), run: choice.run.has(def.id) })));
    } catch {
      return err('The code could not be checked, so nothing was decided.');
    }
    const record: TrustRecord = {
      ...base,
      status: 'decided',
      decidedAt: now,
      decisions,
      snapshots: deck.components.filter((def) => choice.run.has(def.id)).map(snapshotOf),
    };
    const stored = await this.repository.putTrust(record);
    if (!stored.ok) return err(`Could not save your decision: ${stored.error.message}`);
    // The hashes are known now, so the components that were just allowed start without waiting to hash them again.
    deck.components.forEach((def, index) => this.hashSignal(def).set(decisions[index].hash));
    this.records.update((map) => new Map(map).set(deck.id, record));
    return ok(undefined);
  }

  /** The hash of a definition, computed once per definition object (commands replace a definition when it changes). */
  private hashOf(def: ComponentDef): Signal<string | null> {
    return this.hashSignal(def, true);
  }

  private hashSignal(def: ComponentDef, compute = false): WritableSignal<string | null> {
    let hash = this.hashes.get(def);
    if (!hash) {
      const created = signal<string | null>(null);
      hash = created;
      this.hashes.set(def, created);
      if (compute) {
        componentHash(def).then(
          (value) => created.set(value),
          () => undefined, // stays unknown: the component stays off
        );
      }
    }
    return hash;
  }

  private read(deckId: string, force: boolean): Promise<void> {
    const repository = this.repository;
    if (!repository) return Promise.resolve();
    if (!force && this.records().has(deckId)) return Promise.resolve();
    const running = this.reading.get(deckId);
    if (running && !force) return running;
    const token = {};
    const task = (async () => {
      const result = await repository.getTrust(deckId).catch(() => null);
      // A record that cannot be read is treated as pending, never as absent.
      const record = result?.ok ? result.value : pendingRecord(deckId, deckId, '', null);
      // A newer read (a refresh) started meanwhile: its answer is the one to keep.
      if (this.tokens.get(deckId) === token) this.records.update((map) => new Map(map).set(deckId, record));
    })().finally(() => {
      if (this.tokens.get(deckId) === token) {
        this.tokens.delete(deckId);
        this.reading.delete(deckId);
      }
    });
    this.tokens.set(deckId, token);
    this.reading.set(deckId, task);
    return task;
  }
}
