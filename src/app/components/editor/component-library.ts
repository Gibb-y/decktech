import { Service, inject, signal } from '@angular/core';
import { generateId, type AssetRef, type CodeEl, type ComponentDef, type Deck } from '../../core/model';
import { DeckRepository, type LibraryComponent } from '../../core/persistence';
import { AddAsset, AddCodeElement, Batch, CommandError, DeckStore, deepEqual, type Command } from '../../core/store';
import { LiveAnnouncer } from '../../shared';
import { BUILT_IN_COMPONENTS } from './builtin-components';

/** Where a component from the library lands on the slide. */
const GEOMETRY = { x: 360, y: 190, w: 1200, h: 700 };

/**
 * The commands that put `def` on `slideId` as one undo step: its assets first (an asset the deck has
 * is left alone), then the element. A deck that already holds a different definition under the
 * same id (the library entry was edited elsewhere, or the deck's own copy was) gets the entry as a
 * new definition with a fresh id, so neither is overwritten; an identical one is shared.
 */
export function insertCommands(deck: Deck, slideId: string, entry: Pick<LibraryComponent, 'def' | 'assets'>): { command: Command; element: CodeEl } {
  const existing = deck.components.find((c) => c.id === entry.def.id);
  const def: ComponentDef = existing && !deepEqual(existing, entry.def) ? { ...structuredClone(entry.def), id: generateId('component') } : structuredClone(entry.def);
  const assets = [...def.files, ...def.libs].filter((id, i, all) => all.indexOf(id) === i && !Object.hasOwn(deck.assets, id));
  const commands: Command[] = assets.map((id) => {
    const ref = entry.assets[id];
    if (!ref) throw new CommandError(`The library entry "${def.name}" lacks the asset ${id}`);
    return new AddAsset(id, ref);
  });
  const add = new AddCodeElement(slideId, def, GEOMETRY);
  return { command: new Batch(`Insert ${def.name}`, [...commands, add]), element: add.element };
}

/**
 * The component library (arc42 §5.3): the built-in examples plus the components the author saved
 * (in the repository, outside any deck, so every deck can use them). Inserting copies the
 * definition into the deck, so a deck stays self-contained and portable; the copy is shared by the
 * instances in that deck (ADR-010) and can be detached.
 */
@Service()
export class ComponentLibrary {
  private readonly repository = inject(DeckRepository, { optional: true });
  private readonly store = inject(DeckStore);
  private readonly announcer = inject(LiveAnnouncer);

  readonly builtIn: readonly ComponentDef[] = BUILT_IN_COMPONENTS;
  readonly saved = signal<readonly LibraryComponent[]>([]);
  readonly status = signal<'idle' | 'loading' | 'error'>('idle');
  readonly error = signal<string | null>(null);

  async refresh(): Promise<void> {
    if (!this.repository) return;
    this.status.set('loading');
    const result = await this.repository.listComponents();
    if (!result.ok) {
      this.status.set('error');
      this.error.set(result.error.message);
      return;
    }
    this.saved.set(result.value);
    this.error.set(null);
    this.status.set('idle');
  }

  /** Saves `def` (with the refs of its assets taken from the open deck, or `extraAssets` for ones not added to it yet) under its id; resolves to whether it worked. */
  async save(def: ComponentDef, extraAssets: Record<string, AssetRef> = {}): Promise<boolean> {
    if (!this.repository) return this.fail('The library is not available in this session');
    const deckAssets = { ...extraAssets, ...this.store.deck().assets };
    const assets: Record<string, AssetRef> = {};
    for (const id of [...def.files, ...def.libs]) {
      const ref = Object.hasOwn(deckAssets, id) ? deckAssets[id] : undefined;
      if (!ref) return this.fail(`The component uses an asset that is not in this deck (${id})`);
      assets[id] = ref;
    }
    const result = await this.repository.putComponent({ def: structuredClone(def), assets, savedAt: Date.now() });
    if (!result.ok) return this.fail(result.error.message);
    await this.refresh();
    this.announcer.announce(`${def.name} saved to the library`);
    return true;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.repository) return this.fail('The library is not available in this session');
    const result = await this.repository.deleteComponent(id);
    if (!result.ok) return this.fail(result.error.message);
    await this.refresh();
    this.announcer.announce('Removed from the library');
    return true;
  }

  /** Inserts a built-in or saved component into the current slide and selects it. */
  insert(entry: { def: ComponentDef; assets?: Record<string, AssetRef> }): boolean {
    try {
      const { command, element } = insertCommands(this.store.deck(), this.store.currentSlideId(), { def: entry.def, assets: entry.assets ?? {} });
      this.store.execute(command);
      this.store.select([element.id]);
      this.announcer.announce(`${entry.def.name} inserted`);
      return true;
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      return this.fail(e.message);
    }
  }

  private fail(message: string): false {
    this.error.set(message);
    this.announcer.announce(message);
    return false;
  }
}
