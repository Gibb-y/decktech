import { Component, afterNextRender, computed, inject, Injector, output, signal } from '@angular/core';
import { DeckRepository, componentHash, snapshotOf, type ComponentSnapshot } from '../../core/persistence';
import { DeckStore } from '../../core/store';
import { FocusTrap, LiveAnnouncer } from '../../shared';
import { analyzeDeck } from './analysis';
import { CodeInspector, type AssetText } from './code-inspector';
import { TrustStore } from './trust-store';

type Change = 'new' | 'changed' | 'unchanged';

/** Largest text asset the inspector reads into memory. */
const MAX_READ = 5 * 1024 * 1024;

/**
 * The trust dialog (arc42 §6.4, ADR-008): shown for a deck whose code the user has not decided on.
 * It lists every code component with the slides that use it, what it asks for, its libraries and
 * files, and the things worth a closer look, and it lets the user read each component's code in
 * the `CodeInspector` before anything runs: "Read code" is one click from the list, the tab of the
 * source one more. The choices are "Run selected components", "Trust whole deck", "Open with code
 * disabled" and "Cancel" (decide later: nothing runs and nothing is recorded).
 *
 * The dialog and the inspector never create a frame, in any state: they only show text. Running
 * happens afterwards, in the editor, once the decision is stored.
 */
@Component({
  selector: 'app-trust-dialog',
  imports: [FocusTrap, CodeInspector],
  template: `
    <div class="backdrop" aria-hidden="true"></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="trust-title" appFocusTrap (keydown.escape)="onEscape($event)">
      @if (inspected(); as def) {
        <header>
          <h2 id="trust-title" tabindex="-1">Code of {{ def.name }}</h2>
          <button class="btn" type="button" id="trust-back" data-autofocus (click)="back()">Back to the list</button>
        </header>
        <p class="note">Read only. Nothing here runs: the code is shown as text.</p>
        <app-code-inspector class="grow" [component]="def" [base]="baseOf(def.id)" [libraries]="reportOf(def.id)?.libs ?? []" [fileList]="reportOf(def.id)?.files ?? []" [readAsset]="readAsset" />
      } @else {
        <header>
          <h2 id="trust-title" tabindex="-1">{{ title() }}</h2>
        </header>
        <p class="note" id="trust-intro">{{ intro() }}</p>
        <ul class="components" aria-label="Code components">
          @for (row of rows(); track row.id) {
            <li class="component">
              <div class="head">
                <label class="check">
                  <input type="checkbox" [checked]="selected().has(row.id)" (change)="toggle(row.id, $event)" [attr.data-autofocus]="$first ? '' : null" />
                  Run <strong>{{ row.name }}</strong>
                </label>
                @if (row.change; as change) {
                  <span class="badge" [class]="'badge ' + change">{{ changeText(change) }}</span>
                }
                <button class="btn" type="button" [id]="'read-' + row.id" (click)="inspect(row.id)">Read code<span class="sr-only"> of {{ row.name }}</span></button>
              </div>
              <dl>
                <dt>Used on</dt>
                <dd>{{ slidesText(row.slides) }}</dd>
                <dt>Asks for</dt>
                <dd>{{ row.permissions.length > 0 ? row.permissions.join(', ') : 'no permissions' }}</dd>
                <dt>Libraries</dt>
                <dd>{{ libsText(row) }}</dd>
                <dt>Files</dt>
                <dd>{{ row.files.length === 0 ? 'none' : row.files.length }}</dd>
                <dt>Size</dt>
                <dd>{{ row.size }} characters of code</dd>
              </dl>
              @if (row.flags.length > 0) {
                <div class="flags">
                  <p><strong>Worth a closer look</strong></p>
                  <ul>
                    @for (flag of row.flags; track flag.text) {
                      <li>{{ flag.text }}</li>
                    }
                  </ul>
                </div>
              }
            </li>
          } @empty {
            <li class="muted">This deck has no code components.</li>
          }
        </ul>
        <p class="note">These notes are hints from a quick search of the text, not a verdict. The sandbox is what holds the code back.</p>
        @if (error(); as message) {
          <p class="errors" role="alert">{{ message }}</p>
        }
        <footer>
          <button type="button" class="btn btn-primary" [attr.aria-disabled]="selected().size === 0 || busy() ? 'true' : null" (click)="runSelected()">Run selected components ({{ selected().size }})</button>
          <button class="btn" type="button" [attr.aria-disabled]="busy() ? 'true' : null" (click)="trustAll()">Trust whole deck</button>
          <button class="btn" type="button" [attr.aria-disabled]="busy() ? 'true' : null" (click)="disableAll()">Open with code disabled</button>
          <span class="spacer"></span>
          <button class="btn" type="button" (click)="closed.emit()">Cancel</button>
        </footer>
      }
    </div>
  `,
  styleUrl: '../editor/tools-dialog.css',
  styles: `
    .dialog {
      height: auto;
      max-height: calc(100vh - 2rem);
      overflow-y: auto;
    }
    .grow {
      flex: 1 1 auto;
      min-height: 20rem;
      display: flex;
      flex-direction: column;
    }
    .components {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 0.75rem;
    }
    .component {
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.25rem;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 1rem;
    }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.1rem 1rem;
      margin: 0.35rem 0;
      font-size: 0.9rem;
    }
    dt {
      color: var(--text-muted);
    }
    dd {
      margin: 0;
    }
    .flags {
      padding: 0.35rem 0.75rem;
      border-left: 4px solid var(--warning-ink);
      background: var(--warning-subtle);
      color: var(--text);
      font-size: 0.9rem;
    }
    .flags p,
    .flags ul {
      margin: 0.15rem 0;
    }
    .badge {
      padding: 0.05rem 0.5rem;
      border: 1px solid currentColor;
      border-radius: 1rem;
      font-size: 0.8rem;
    }
    .badge.changed {
      color: var(--warning-ink);
    }
    .badge.new {
      color: var(--text);
    }
    .badge.unchanged {
      color: var(--success-ink);
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
})
export class TrustDialog {
  private readonly store = inject(DeckStore);
  private readonly trust = inject(TrustStore);
  private readonly repository = inject(DeckRepository, { optional: true });
  private readonly announcer = inject(LiveAnnouncer);
  private readonly injector = inject(Injector);

  readonly closed = output<void>();

  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly inspectedId = signal<string | null>(null);
  private readonly known = signal<ReadonlySet<string>>(new Set());

  private readonly deck = this.store.deck;
  private readonly report = computed(() => analyzeDeck(this.deck(), this.known()));
  private readonly base = computed(() => new Map(this.trust.diffBase(this.deck().id).map((s) => [s.componentId, s])));

  /** The components the user ticked to run; starts with those that run now. */
  protected readonly selected = signal<ReadonlySet<string>>(new Set());

  protected readonly rows = computed(() => {
    const base = this.base();
    const hasBase = base.size > 0;
    const defs = new Map(this.deck().components.map((def) => [def.id, def]));
    return this.report().components.map((component) => {
      const def = defs.get(component.id);
      const before = base.get(component.id);
      const change: Change | null = !hasBase || !def ? null : !before ? 'new' : sameSnapshot(before, snapshotOf(def)) ? 'unchanged' : 'changed';
      return { ...component, change };
    });
  });

  protected readonly inspected = computed(() => {
    const id = this.inspectedId();
    return id === null ? null : (this.deck().components.find((def) => def.id === id) ?? null);
  });

  protected readonly title = computed(() => `Review the code in “${this.deck().title}”`);
  protected readonly intro = computed(() => {
    const record = this.trust.record(this.deck().id);
    const earlier = this.base().size > 0;
    const lead = record?.status === 'decided' ? 'The code in this deck has changed since you decided what may run.' : 'This deck came from a file. Its code components stay switched off until you decide.';
    return `${lead} Read what each component does, then choose what runs.${earlier ? ' Components marked “Changed” or “New” differ from the version you trusted before; open them to see the differences.' : ''}`;
  });

  /** Reads the text of a library or file the deck stores. Not a frame, not markup: a string. */
  protected readonly readAsset: AssetText = async (assetId) => {
    const assets = this.deck().assets;
    const ref = Object.hasOwn(assets, assetId) ? assets[assetId] : undefined;
    if (!this.repository || !ref || ref.size > MAX_READ || !/^(?:text\/|application\/(?:json|javascript))|\+(?:json|xml)$|^image\/svg\+xml$/.test(ref.mime)) return null;
    const blob = await this.repository.getAsset(assetId);
    return blob.ok ? blob.value.text() : null;
  };

  private touched = false;

  constructor() {
    void this.preselect();
    void this.trust.knownLibraries().then((known) => this.known.set(known));
  }

  /** Ticks the components whose current content has a "run" decision; the hashes arrive asynchronously, so this waits for them. */
  private async preselect(): Promise<void> {
    const record = this.trust.record(this.deck().id);
    if (!record) return;
    const hashes = await Promise.all(this.deck().components.map(async (def) => [def.id, await componentHash(def)] as const));
    if (this.touched) return;
    this.selected.set(new Set(hashes.filter(([id, hash]) => record.decisions.some((d) => d.componentId === id && d.hash === hash && d.run)).map(([id]) => id)));
  }

  protected reportOf(id: string) {
    return this.report().components.find((c) => c.id === id);
  }

  protected baseOf(id: string): ComponentSnapshot | null {
    return this.base().get(id) ?? null;
  }

  protected changeText(change: Change): string {
    return change === 'new' ? 'New' : change === 'changed' ? 'Changed since you trusted it' : 'Unchanged since you trusted it';
  }

  protected slidesText(slides: readonly number[]): string {
    if (slides.length === 0) return 'no slide';
    return `${slides.length === 1 ? 'slide' : 'slides'} ${slides.join(', ')}`;
  }

  protected libsText(row: { libs: readonly { known: boolean }[] }): string {
    if (row.libs.length === 0) return 'none';
    const known = row.libs.filter((lib) => lib.known).length;
    return `${row.libs.length} (${known} known)`;
  }

  protected toggle(id: string, event: Event): void {
    this.touched = true;
    const checked = (event.target as HTMLInputElement).checked;
    this.selected.update((set) => {
      const next = new Set(set);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  protected inspect(id: string): void {
    this.inspectedId.set(id);
    this.focusLater('trust-title');
  }

  protected back(): void {
    const id = this.inspectedId();
    this.inspectedId.set(null);
    if (id) this.focusLater(`read-${id}`);
  }

  protected onEscape(event: Event): void {
    if (event.defaultPrevented) return; // the search box of the viewer used it
    event.preventDefault();
    if (this.inspectedId() !== null) this.back();
    else this.closed.emit();
  }

  protected runSelected(): void {
    if (this.selected().size === 0 || this.busy()) return;
    void this.decide(this.selected(), 'Selected components will run');
  }

  protected trustAll(): void {
    void this.decide(new Set(this.deck().components.map((def) => def.id)), 'The whole deck is trusted');
  }

  protected disableAll(): void {
    void this.decide(new Set(), 'The deck opens with its code disabled');
  }

  private async decide(run: ReadonlySet<string>, announcement: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    const result = await this.trust.decide(this.deck(), { run });
    this.busy.set(false);
    if (!result.ok) return this.error.set(result.error);
    this.announcer.announce(announcement);
    this.closed.emit();
  }

  private focusLater(id: string): void {
    afterNextRender(() => document.getElementById(id)?.focus(), { injector: this.injector });
  }
}

const sameSnapshot = (a: ComponentSnapshot, b: ComponentSnapshot): boolean => JSON.stringify(a) === JSON.stringify(b);
