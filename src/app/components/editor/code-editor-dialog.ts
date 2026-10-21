import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { validateComponent, type AssetRef, type CodeEl, type ComponentDef, type Permission, type PropSpec } from '../../core/model';
import { DeckRepository } from '../../core/persistence';
import { AddAsset, Batch, CommandError, DeckStore, SetComponentDef, SetComponentSource, componentUses, deepEqual, type Command } from '../../core/store';
import { FocusTrap, LiveAnnouncer } from '../../shared';
import { CodeElementRenderer } from '../host/code-element-renderer';
import { HostConsole, ComponentStateStore } from '../host/host-services';
import { CodeMirror } from './code-mirror';
import { ComponentLibrary } from './component-library';
import { PropSchemaEditor } from './prop-schema-editor';
import { accessibilityHints, fetchLibrary, networkDependencies, readLibraryFile } from './vendor';

type Tab = 'html' | 'css' | 'js' | 'props' | 'libs' | 'perms';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'js', label: 'JavaScript' },
  { id: 'props', label: 'Properties' },
  { id: 'libs', label: 'Libraries' },
  { id: 'perms', label: 'Permissions' },
];

const PERMISSIONS: readonly { id: Permission; label: string; consent: string }[] = [
  {
    id: 'network',
    label: 'Network',
    consent: 'The component will say it wants to reach web addresses. Nothing is allowed through yet: the addresses it may reach are chosen when the deck is trusted, and until then the network stays blocked.',
  },
  {
    id: 'storage',
    label: 'Storage',
    consent: 'The component will say it wants to keep data. It can already keep small values with deck.state; this is shown to people who open the deck.',
  },
];

/** The id of the element that stands in for the real one in the preview, so its saved state is separate. */
const PREVIEW_ID = 'el_preview';
const PREVIEW_WIDTH = 560;
const PREVIEW_DELAY_MS = 300;

const CHECKLIST = [
  'Everything works with the keyboard alone',
  'Text has a contrast of at least 4.5 : 1 against its background',
  'Pictures have a text alternative',
  'Meaning is not carried by colour alone',
  'Motion stops or is reduced for prefers-reduced-motion',
];

/**
 * The code editor of a code component (arc42 §5.3, 6.2). The draft (sources, name, property schema,
 * permissions, libraries) lives in this dialog; the live preview is a real component instance that
 * is rebuilt as a fresh frame 300 ms after the last change, exactly as it will be presented. Done
 * applies the draft as one undo step (`SetComponentSource`, `SetComponentDef`, and `AddAsset` for
 * libraries added now), which changes every instance of the definition (ADR-010); Cancel throws
 * the draft away (after asking, if there is one).
 */
@Component({
  selector: 'app-code-editor-dialog',
  imports: [FocusTrap, CodeMirror, CodeElementRenderer, PropSchemaEditor],
  template: `
    <div class="backdrop" aria-hidden="true"></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="code-editor-title" appFocusTrap (keydown.escape)="onEscape($event)">
      <header>
        <h2 id="code-editor-title">Edit code: {{ initial.name }}</h2>
        <label>Name <input type="text" [value]="name()" (input)="name.set(text($event))" data-autofocus /></label>
        @if (uses() > 1) {
          <p class="note" role="note">This component is used {{ uses() }} times. Changes apply to every use; detach one from the properties panel to give it its own copy.</p>
        }
      </header>

      <div class="body">
        <section class="work" aria-label="Component code">
          <div role="tablist" aria-label="Component parts" (keydown)="onTabKey($event)">
            @for (t of tabs; track t.id) {
              <button type="button" role="tab" [id]="'tab-' + t.id" [attr.aria-selected]="tab() === t.id" [attr.aria-controls]="'panel-' + t.id" [tabindex]="tab() === t.id ? 0 : -1" (click)="tab.set(t.id)">{{ t.label }}</button>
            }
          </div>
          @for (t of codeTabs; track t.id) {
            <div role="tabpanel" class="panel" [id]="'panel-' + t.id" [attr.aria-labelledby]="'tab-' + t.id" [hidden]="tab() !== t.id">
              <app-code-mirror [value]="source(t.id)" [language]="t.id" [label]="t.label + ' source'" (changed)="setSource(t.id, $event)" />
              <p class="hint">Tab leaves the editor. Ctrl+] indents, Ctrl+[ outdents, Escape closes the dialog.</p>
            </div>
          }
          <div role="tabpanel" class="panel scroll" id="panel-props" aria-labelledby="tab-props" [hidden]="tab() !== 'props'">
            <app-prop-schema-editor [specs]="propSchema()" (changed)="propSchema.set($event)" />
          </div>
          <div role="tabpanel" class="panel scroll" id="panel-libs" aria-labelledby="tab-libs" [hidden]="tab() !== 'libs'">
            <p class="hint">Libraries are stored in the deck and work offline. In the JavaScript, import one by the name shown here.</p>
            @if (libs().length === 0) {
              <p>No libraries yet.</p>
            }
            <ul class="libs">
              @for (id of libs(); track id) {
                <li>
                  <span>{{ libLabels()[id] ?? 'Library' }} <code>import * as lib from '{{ id }}'</code></span>
                  <button type="button" (click)="removeLibrary(id)" [attr.aria-label]="'Remove library ' + (libLabels()[id] ?? id.slice(0, 8))">Remove</button>
                </li>
              }
            </ul>
            <div class="row">
              <label>Add from a file (.js or .mjs, self-contained) <input type="file" accept=".js,.mjs,text/javascript" (change)="addFromFile($event)" /></label>
            </div>
            <fieldset>
              <legend>Download from npm once, while online</legend>
              <label>Package <input type="text" [value]="npmName()" (input)="npmName.set(text($event))" spellcheck="false" placeholder="chart.js" /></label>
              <label>Version <input type="text" [value]="npmVersion()" (input)="npmVersion.set(text($event))" spellcheck="false" placeholder="latest" /></label>
              <button type="button" (click)="addFromNpm()" [attr.aria-disabled]="busy() ? 'true' : null">Download and add</button>
            </fieldset>
            @if (libraryMessage(); as message) {
              <p role="status" class="status">{{ message }}</p>
            }
          </div>
          <div role="tabpanel" class="panel scroll" id="panel-perms" aria-labelledby="tab-perms" [hidden]="tab() !== 'perms'">
            <fieldset>
              <legend>What the component may ask for</legend>
              @for (p of permissionList; track p.id) {
                <label class="check"><input type="checkbox" [checked]="permissions().includes(p.id)" (change)="togglePermission(p.id, $event)" /> {{ p.label }}</label>
              }
            </fieldset>
            @if (pending(); as asked) {
              <div class="consent" role="alertdialog" aria-labelledby="consent-title" aria-describedby="consent-text">
                <p id="consent-title"><strong>Allow {{ asked.label }}?</strong></p>
                <p id="consent-text">{{ asked.consent }}</p>
                <button type="button" (click)="grant()">Allow</button>
                <button type="button" (click)="pending.set(null)">Cancel</button>
              </div>
            }
          </div>
          @if (netDeps().length > 0) {
            <div class="risk" role="note">
              <p>This code loads from the network, so it will not work offline:</p>
              <ul>
                @for (url of netDeps(); track url) {
                  <li>
                    <code>{{ url }}</code>
                  </li>
                }
              </ul>
              <p>Add the library in the Libraries tab instead.</p>
            </div>
          }
        </section>

        <aside class="side" aria-label="Preview and diagnostics">
          <h3>Preview</h3>
          <div class="preview" [style.width.px]="previewSize().w" [style.height.px]="previewSize().h">
            <div class="stage" [style.width.px]="stageSize().w" [style.height.px]="stageSize().h" [style.transform]="'scale(' + previewSize().k + ')'">
              <app-code-element [elements]="previewElements()" [elementId]="previewId" [theme]="theme()" mode="edit" [components]="previewComponents()" [deckId]="deckId()" />
            </div>
          </div>
          <h3 id="console-title">Console</h3>
          <div class="console" role="log" aria-labelledby="console-title" tabindex="0">
            @for (entry of consoleEntries(); track entry.seq) {
              <div [class]="'line ' + entry.level"><span class="level">{{ entry.level }}</span> {{ entry.text }}</div>
            } @empty {
              <span class="muted">Nothing logged. Use deck.log(…) or console.log(…).</span>
            }
          </div>
          <button type="button" (click)="hostConsole.clear()">Clear console</button>
          <fieldset>
            <legend>Accessibility checklist</legend>
            @for (item of checklist; track item) {
              <label class="check"><input type="checkbox" /> {{ item }}</label>
            }
            @if (hints().length > 0) {
              <ul class="hints" aria-label="Possible problems found in the code">
                @for (hint of hints(); track hint) {
                  <li>{{ hint }}</li>
                }
              </ul>
            }
          </fieldset>
        </aside>
      </div>

      @if (problems().length > 0) {
        <ul class="errors" role="alert" aria-label="Problems to fix before saving">
          @for (problem of problems(); track problem) {
            <li>{{ problem }}</li>
          }
        </ul>
      }
      @if (error(); as message) {
        <p class="errors" role="alert">{{ message }}</p>
      }
      @if (confirmDiscard()) {
        <div class="consent" role="alertdialog" aria-labelledby="discard-text">
          <p id="discard-text">Discard your changes to this component?</p>
          <button type="button" (click)="closed.emit()">Discard</button>
          <button type="button" (click)="confirmDiscard.set(false)">Keep editing</button>
        </div>
      }
      <footer>
        <button type="button" (click)="saveToLibrary()">Save to library</button>
        <span class="spacer"></span>
        <button type="button" (click)="cancel()">Cancel</button>
        <button type="button" class="primary" (click)="done()" [attr.aria-disabled]="problems().length > 0 ? 'true' : null">Done</button>
      </footer>
    </div>
  `,
  styleUrl: './tools-dialog.css',
})
export class CodeEditorDialog {
  /** The code element being edited. */
  readonly elementId = input.required<string>();
  readonly closed = output<void>();

  protected readonly store = inject(DeckStore);
  protected readonly hostConsole = inject(HostConsole);
  private readonly library = inject(ComponentLibrary);
  private readonly repository = inject(DeckRepository, { optional: true });
  private readonly announcer = inject(LiveAnnouncer);
  private readonly stateStore = inject(ComponentStateStore);

  protected readonly tabs = TABS;
  protected readonly codeTabs = TABS.slice(0, 3) as { id: 'html' | 'css' | 'js'; label: string }[];
  protected readonly permissionList = PERMISSIONS;
  protected readonly checklist = CHECKLIST;
  protected readonly previewId = PREVIEW_ID;

  /** The element and definition as they were when the dialog opened; the draft starts from them. */
  private readonly element = computed(() => {
    for (const slide of this.store.deck().slides) {
      const found = slide.elements.find((e) => e.id === this.elementId());
      if (found?.type === 'code') return found;
    }
    return undefined;
  });

  protected readonly tab = signal<Tab>('html');
  protected readonly name = signal('');
  private readonly sources = signal({ html: '', css: '', js: '' });
  protected readonly propSchema = signal<PropSpec[]>([]);
  protected readonly permissions = signal<Permission[]>([]);
  protected readonly libs = signal<string[]>([]);
  /** Libraries added in this dialog: not in the deck until Done. */
  private readonly newAssets = signal<Record<string, AssetRef>>({});
  protected readonly libLabels = signal<Record<string, string>>({});
  protected readonly pending = signal<(typeof PERMISSIONS)[number] | null>(null);
  protected readonly confirmDiscard = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly libraryMessage = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly npmName = signal('');
  protected readonly npmVersion = signal('');

  protected readonly initial: ComponentDef;
  protected readonly draft = computed<ComponentDef>(() => ({
    id: this.initial.id,
    name: this.name().trim(),
    ...this.sources(),
    propSchema: this.propSchema(),
    permissions: this.permissions(),
    files: this.initial.files,
    libs: this.libs(),
  }));
  protected readonly dirty = computed(() => !deepEqual(this.draft(), { ...this.initial, name: this.initial.name.trim() }));
  protected readonly problems = computed(() => {
    const result = validateComponent(this.draft(), [...Object.keys(this.store.deck().assets), ...Object.keys(this.newAssets())]);
    return result.ok ? [] : result.error.map((p) => `${p.path.replace(/^component\.?/, '') || 'component'}: ${p.message}`);
  });
  protected readonly uses = computed(() => componentUses(this.store.deck(), this.initial.id));
  protected readonly deckId = computed(() => this.store.deck().id);
  protected readonly theme = computed(() => this.store.deck().theme);
  protected readonly netDeps = computed(() => networkDependencies(this.sources()));
  protected readonly hints = computed(() => accessibilityHints(this.sources()));

  // ------------------------------------------------------------ preview

  /** The definition the preview runs: the draft, `PREVIEW_DELAY_MS` after the last change, so typing does not rebuild the frame on every key. */
  private readonly previewDef = signal<ComponentDef>(undefined as unknown as ComponentDef);
  protected readonly previewComponents = computed(() => [this.previewDef()]);
  protected readonly previewElements = computed<ReadonlyMap<string, CodeEl>>(() => {
    const real = this.element();
    const base: CodeEl = real ?? ({ id: PREVIEW_ID, type: 'code', x: 0, y: 0, w: 1200, h: 700, rotation: 0, componentId: this.initial.id, props: {} } as CodeEl);
    return new Map([[PREVIEW_ID, { ...base, id: PREVIEW_ID, x: 0, y: 0, rotation: 0, hidden: false, step: undefined }]]);
  });
  protected readonly stageSize = computed(() => {
    const el = this.previewElements().get(PREVIEW_ID);
    return { w: Math.max(1, el?.w ?? 1200), h: Math.max(1, el?.h ?? 700) };
  });
  protected readonly previewSize = computed(() => {
    const { w, h } = this.stageSize();
    const k = PREVIEW_WIDTH / w;
    return { w: PREVIEW_WIDTH, h: Math.round(h * k), k };
  });
  protected readonly consoleEntries = computed(() => this.hostConsole.entries().filter((e) => e.componentId === this.initial.id));

  constructor() {
    const element = untracked(this.element);
    const def = element ? untracked(this.store.deck).components.find((c) => c.id === element.componentId) : undefined;
    if (!def) throw new Error('The code component to edit does not exist');
    this.initial = def;
    this.name.set(def.name);
    this.sources.set({ html: def.html, css: def.css, js: def.js });
    this.propSchema.set(structuredClone(def.propSchema));
    this.permissions.set([...def.permissions]);
    this.libs.set([...def.libs]);
    this.previewDef.set(def);
    // The preview keeps its own state, and starts without any, so an old run does not colour this one.
    this.stateStore.save(untracked(this.deckId), PREVIEW_ID, {});
    this.hostConsole.clear();

    let timer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const next = this.draft();
      untracked(() => {
        clearTimeout(timer);
        timer = setTimeout(() => this.previewDef.set(next), PREVIEW_DELAY_MS);
      });
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(timer));
  }

  // ------------------------------------------------------------ editing

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected source(id: 'html' | 'css' | 'js'): string {
    return this.sources()[id];
  }

  protected setSource(id: 'html' | 'css' | 'js', value: string): void {
    this.sources.update((s) => (s[id] === value ? s : { ...s, [id]: value }));
  }

  protected onTabKey(event: KeyboardEvent): void {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    const current = TABS.findIndex((t) => t.id === this.tab());
    let next = current;
    if (event.key in moves) next = (current + moves[event.key] + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    this.tab.set(TABS[next].id);
    queueMicrotask(() => (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`#tab-${TABS[next].id}`)?.focus());
  }

  protected togglePermission(id: Permission, event: Event): void {
    const box = event.target as HTMLInputElement;
    if (!box.checked) return void this.permissions.update((list) => list.filter((p) => p !== id));
    // Granting shows what it means first; the box only stays ticked once the author agrees.
    box.checked = false;
    this.pending.set(PERMISSIONS.find((p) => p.id === id) ?? null);
  }

  protected grant(): void {
    const asked = this.pending();
    if (asked) this.permissions.update((list) => (list.includes(asked.id) ? list : [...list, asked.id]));
    this.pending.set(null);
  }

  // ------------------------------------------------------------ libraries

  protected async addFromFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const checked = await readLibraryFile(file);
    if (!checked.ok) return this.libraryMessage.set(checked.error);
    await this.vendor(checked.value, file.name);
  }

  protected async addFromNpm(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.libraryMessage.set('Downloading…');
    try {
      const fetched = await fetchLibrary(this.npmName(), this.npmVersion(), (url) => fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' }));
      if (!fetched.ok) return this.libraryMessage.set(fetched.error);
      await this.vendor(fetched.value.blob, fetched.value.label);
    } finally {
      this.busy.set(false);
    }
  }

  private async vendor(blob: Blob, label: string): Promise<void> {
    if (!this.repository) return this.libraryMessage.set('Libraries cannot be stored in this session');
    const stored = await this.repository.putAsset(blob);
    if (!stored.ok) return this.libraryMessage.set(`The library could not be stored: ${stored.error.message}`);
    const { ref } = stored.value;
    this.newAssets.update((m) => ({ ...m, [ref.hash]: ref }));
    this.libLabels.update((m) => ({ ...m, [ref.hash]: label }));
    this.libs.update((list) => (list.includes(ref.hash) ? list : [...list, ref.hash]));
    this.libraryMessage.set(`Added ${label}. Import it with: import * as lib from '${ref.hash}'`);
  }

  protected removeLibrary(id: string): void {
    this.libs.update((list) => list.filter((l) => l !== id));
  }

  // ------------------------------------------------------------ finishing

  protected done(): void {
    if (this.problems().length > 0) {
      this.announcer.announce(`Cannot save yet: ${this.problems()[0]}`);
      return;
    }
    const draft = this.draft();
    const deckAssets = this.store.deck().assets;
    const commands: Command[] = Object.entries(this.newAssets())
      .filter(([id]) => draft.libs.includes(id) && !Object.hasOwn(deckAssets, id))
      .map(([id, ref]) => new AddAsset(id, ref));
    commands.push(
      new SetComponentSource(draft.id, { html: draft.html, css: draft.css, js: draft.js }),
      new SetComponentDef(draft.id, { name: draft.name, propSchema: draft.propSchema, permissions: draft.permissions, libs: draft.libs }),
    );
    try {
      this.store.execute(new Batch('Edit component', commands));
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      this.error.set(e.message);
      return;
    }
    this.announcer.announce(`${draft.name} updated`);
    this.closed.emit();
  }

  protected cancel(): void {
    if (this.dirty()) this.confirmDiscard.set(true);
    else this.closed.emit();
  }

  protected onEscape(event: Event): void {
    // An open completion list or search panel in the editor used this Escape already.
    if (event.defaultPrevented) return;
    event.preventDefault();
    this.cancel();
  }

  protected async saveToLibrary(): Promise<void> {
    if (this.problems().length > 0) return void this.announcer.announce(`Cannot save to the library yet: ${this.problems()[0]}`);
    await this.library.save(this.draft(), this.newAssets());
  }
}
