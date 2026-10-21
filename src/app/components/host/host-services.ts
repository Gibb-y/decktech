import { DOCUMENT } from '@angular/common';
import { Service, inject, signal } from '@angular/core';
import type { ComponentDef } from '../../core/model';
import { DeckRepository } from '../../core/persistence';
import { BRIDGE_LIMITS, measureJson, type JsonValue, type LogLevel } from './protocol';

export interface ConsoleEntry {
  seq: number;
  componentId: string;
  /** `host` entries come from the supervisor (a frame that stopped answering), the rest from the component. */
  level: LogLevel | 'host';
  text: string;
}

const CONSOLE_CAPACITY = 200;

/** Collects what components log and the errors they raise, tagged by component (arc42 §8.9). */
@Service()
export class HostConsole {
  private seq = 0;
  readonly entries = signal<readonly ConsoleEntry[]>([]);

  add(componentId: string, level: ConsoleEntry['level'], args: readonly unknown[]): void {
    const text = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg))).join(' ');
    this.entries.update((entries) => [...entries.slice(-(CONSOLE_CAPACITY - 1)), { seq: ++this.seq, componentId, level, text: text.slice(0, 2000) }]);
  }

  clear(): void {
    this.entries.set([]);
  }
}

/**
 * Which origins a component may reach. The `network` permission on a `ComponentDef` only says
 * the component asks; the grant, and the origins, belong to the user and come with the trust
 * dialog (ADR-008, a later issue). Until then nothing is granted. Replace this service to grant.
 */
@Service()
export class ComponentPolicy {
  networkOrigins(def: Pick<ComponentDef, 'id' | 'permissions'>): readonly string[] {
    void def;
    return [];
  }
}

/** The text of `deck-runtime.js`, fetched once from the app's own static files. */
@Service()
export class RuntimeSource {
  private readonly document = inject(DOCUMENT);
  private text: Promise<string> | null = null;

  load(): Promise<string> {
    this.text ??= this.fetchText().catch((error: unknown) => {
      this.text = null; // try again on the next frame
      throw error;
    });
    return this.text;
  }

  private async fetchText(): Promise<string> {
    const response = await fetch(new URL('deck-runtime.js', this.document.baseURI));
    if (!response.ok) throw new Error(`deck-runtime.js could not be loaded (${response.status})`);
    return response.text();
  }
}

/** Opens a link a component asked for, after the user agreed (arc42 §8.2, "Navigation"). */
@Service()
export class LinkGuard {
  private readonly view = inject(DOCUMENT).defaultView;

  /** Returns whether the link was opened. The caller has checked that the address is safe. */
  open(url: string): boolean {
    if (!this.view || !this.view.confirm(`A component wants to open this address in a new tab:\n\n${url}\n\nOpen it?`)) return false;
    this.view.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
}

/** Reads the bytes of the assets a component declared (`files`, `libs`). */
@Service()
export class ComponentAssets {
  private readonly repository = inject(DeckRepository, { optional: true });

  async read(assetId: string): Promise<{ mime: string; data: ArrayBuffer } | null> {
    if (!this.repository) return null;
    const result = await this.repository.getAsset(assetId);
    if (!result.ok) return null;
    return { mime: result.value.type, data: await result.value.arrayBuffer() };
  }
}

/**
 * `deck.state` of one component instance, kept per deck and element so it survives reloads of the
 * frame and of the app (6.2). It is browser-local (`localStorage` of the host, never reachable
 * from a frame) and not part of the deck, so it is neither undoable nor exported. Where storage is
 * unavailable it lives in memory for the session.
 */
@Service()
export class ComponentStateStore {
  private readonly fallback = new Map<string, Record<string, JsonValue>>();
  private readonly storage = ((): Storage | null => {
    try {
      return inject(DOCUMENT).defaultView?.localStorage ?? null;
    } catch {
      return null;
    }
  })();

  load(deckId: string, elementId: string): Record<string, JsonValue> {
    const key = this.key(deckId, elementId);
    const kept = this.fallback.get(key);
    if (kept) return { ...kept };
    try {
      const raw = this.storage?.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && measureJson(parsed, BRIDGE_LIMITS.maxStateBytes) !== null) {
        return parsed as Record<string, JsonValue>;
      }
    } catch {
      // unreadable or corrupt: start empty
    }
    return {};
  }

  save(deckId: string, elementId: string, state: Record<string, JsonValue>): void {
    const key = this.key(deckId, elementId);
    this.fallback.set(key, { ...state });
    try {
      this.storage?.setItem(key, JSON.stringify(state));
    } catch {
      // quota or blocked storage: the in-memory copy still serves this session
    }
  }

  private key(deckId: string, elementId: string): string {
    return `decktech:component-state:${deckId}:${elementId}`;
  }
}

