import { generateId, validateDeck, type Deck } from '../src/app/core/model';
import { CommandError, type Command } from '../src/app/core/store/command';
import { Batch } from '../src/app/core/store/commands';
import { FileLibrary } from './library';
import { ToolError } from './tool';

/** Undo steps kept per deck, as in the editor. */
export const MAX_HISTORY = 200;
/** Decks open at once; each holds its asset bytes in memory. */
export const MAX_OPEN_DECKS = 20;

/** One open deck: an immutable document, the bytes of its assets and an undo history of earlier documents. */
export class DeckSession {
  private readonly undoStack: Deck[] = [];
  private redoStack: Deck[] = [];

  constructor(
    private current: Deck,
    readonly assets: Map<string, Uint8Array> = new Map(),
    /** The deck came from a file: it may carry code nobody has reviewed (ADR-008). */
    readonly imported = false,
  ) {}

  get deck(): Deck {
    return this.current;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Runs the commands in order as one undo step. The result must still pass `validateDeck`; if a
   * command throws or the deck would be invalid, nothing changes (the state is only committed last).
   */
  apply(name: string, ...commands: Command[]): Deck {
    const command = commands.length === 1 ? commands[0] : new Batch(name, commands);
    let next: Deck;
    try {
      next = command.do(this.current).deck;
    } catch (e) {
      if (e instanceof CommandError) throw new ToolError(e.message);
      throw e;
    }
    if (next === this.current) return next;
    const checked = validateDeck(next);
    if (!checked.ok) {
      const first = checked.error.slice(0, 5).map((p) => `${p.path} ${p.message}`).join('; ');
      throw new ToolError(`The change would make the deck invalid and was not applied: ${first}`);
    }
    this.undoStack.push(this.current);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.current = next;
    return next;
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.redoStack.push(this.current);
    this.current = previous;
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.current);
    this.current = next;
    return true;
  }
}

export interface WorkspaceOptions {
  /** Folder the agent may read from and write to; paths are resolved inside it. */
  root: string;
  /** Folder of the file-based component library (`<id>.json` per component). */
  libraryDir: string;
}

/** The decks open in this server process and where its files live. Nothing is persisted except by `export_deck`. */
export class Workspace {
  private readonly sessions = new Map<string, DeckSession>();
  readonly library: FileLibrary;

  constructor(readonly options: WorkspaceOptions) {
    this.library = new FileLibrary(options.libraryDir);
  }

  get root(): string {
    return this.options.root;
  }

  get libraryDir(): string {
    return this.options.libraryDir;
  }

  /** Registers a deck. A taken deck id is replaced by a new one: opening never replaces an open deck. */
  add(deck: Deck, assets?: Map<string, Uint8Array>, imported = false): { session: DeckSession; deck: Deck } {
    if (this.sessions.size >= MAX_OPEN_DECKS) {
      throw new ToolError(`${MAX_OPEN_DECKS} decks are open already; close one with close_deck first`);
    }
    const stored = this.sessions.has(deck.id) ? { ...deck, id: generateId('deck') } : deck;
    const session = new DeckSession(stored, assets, imported);
    this.sessions.set(stored.id, session);
    return { session, deck: stored };
  }

  get(deckId: string): DeckSession {
    const session = this.sessions.get(deckId);
    if (!session) {
      const open = [...this.sessions.keys()];
      throw new ToolError(`No deck "${deckId}" is open. ${open.length > 0 ? `Open decks: ${open.join(', ')}.` : 'Create one with create_deck or open one with open_deck.'}`);
    }
    return session;
  }

  close(deckId: string): void {
    this.get(deckId);
    this.sessions.delete(deckId);
  }

  list(): DeckSession[] {
    return [...this.sessions.values()];
  }
}
