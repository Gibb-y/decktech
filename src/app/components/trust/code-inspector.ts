import { Component, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { snapshotOf, type ComponentSnapshot } from '../../core/persistence';
import { type ComponentDef } from '../../core/model';
import { CodeMirror, type CodeLanguage } from '../editor/code-mirror';
import type { LibraryInfo, FileInfo } from './analysis';
import { foldUnchanged, hasChanges, lineDiff, type DiffLine, type Folded } from './diff';
import { formatForViewing } from './format';

export type InspectorTab = 'changes' | 'html' | 'css' | 'js' | 'props' | 'libs' | 'files';

interface Section {
  title: string;
  lines: (DiffLine | Folded)[];
}

/** Reads the text of an asset, or `null` when it is missing or not text. Injected so the inspector never touches storage itself. */
export type AssetText = (assetId: string) => Promise<string | null>;

/** Largest library or file shown as text; a bigger one shows its size and digest only. */
export const MAX_ASSET_TEXT = 5 * 1024 * 1024;

const TAB_LABELS: Record<InspectorTab, string> = { changes: 'Changes', html: 'HTML', css: 'CSS', js: 'JS', props: 'Props', libs: 'Libraries', files: 'Files' };

const sectionsOf = (before: ComponentSnapshot, after: ComponentSnapshot): Section[] => {
  const meta = (s: ComponentSnapshot) => `name: ${s.name}\npermissions: ${s.permissions.join(', ') || 'none'}\nlibraries: ${s.libs.join(', ') || 'none'}\nfiles: ${s.files.join(', ') || 'none'}`;
  const pairs: [string, string, string][] = [
    ['Name, permissions, libraries and files', meta(before), meta(after)],
    ['HTML', before.html, after.html],
    ['CSS', before.css, after.css],
    ['JavaScript', before.js, after.js],
    ['Property schema', before.props, after.props],
  ];
  return pairs.flatMap(([title, a, b]) => {
    const lines = lineDiff(a, b);
    return hasChanges(lines) ? [{ title, lines: foldUnchanged(lines) }] : [];
  });
};

/**
 * The read-only viewer of a component's code (ADR-008): tabs for HTML, CSS, JS, the property
 * schema, libraries and files, with search, a "Format" copy for minified code, the known-library
 * check and, when the component was trusted before, a per-component diff against that version.
 *
 * It only ever shows text: CodeMirror draws text nodes, the diff is drawn by interpolation, and
 * nothing here creates a frame, evaluates a string or renders markup. It takes the sources from a
 * `ComponentDef` as data and never talks to the code host.
 */
@Component({
  selector: 'app-code-inspector',
  imports: [CodeMirror],
  template: `
    <div class="inspector">
      <div role="tablist" aria-label="Parts of the component">
        @for (id of tabs(); track id) {
          <button class="btn"
            type="button"
            role="tab"
            [id]="'inspect-tab-' + id"
            [attr.aria-selected]="tab() === id"
            [attr.aria-controls]="'inspect-panel-' + id"
            [tabindex]="tab() === id ? 0 : -1"
            (click)="select(id)"
            (keydown)="onTabKey($event)"
          >
            {{ label(id) }}
          </button>
        }
      </div>

      <div role="tabpanel" class="panel" [id]="'inspect-panel-' + tab()" [attr.aria-labelledby]="'inspect-tab-' + tab()">
        @switch (tab()) {
          @case ('changes') {
            @if (sections().length === 0) {
              <p class="muted">Nothing changed since the version you trusted.</p>
            }
            @for (section of sections(); track section.title) {
              <h3>{{ section.title }}</h3>
              <div class="diff" role="group" [attr.aria-label]="'Changes in ' + section.title">
                @for (line of section.lines; track $index) {
                  @if (line.kind === 'fold') {
                    <div class="line fold">{{ line.count }} unchanged {{ line.count === 1 ? 'line' : 'lines' }}</div>
                  } @else {
                    <div class="line" [class.add]="line.kind === 'add'" [class.del]="line.kind === 'del'">
                      <span class="mark" aria-hidden="true">{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ' }}</span>
                      @if (line.kind !== 'same') {
                        <span class="sr-only">{{ line.kind === 'add' ? 'Added: ' : 'Removed: ' }}</span>
                      }
                      <span class="text">{{ line.text }}</span>
                    </div>
                  }
                }
              </div>
            }
          }
          @case ('libs') {
            @if (libs().length === 0) {
              <p class="muted">This component has no libraries.</p>
            }
            <ul class="assets">
              @for (lib of libs(); track lib.id) {
                <li>
                  <p>
                    <code>{{ lib.id }}</code> — {{ lib.size }} bytes —
                    @if (lib.known) {
                      <strong class="known">Known library</strong> (the same file as a library you trusted before)
                    } @else {
                      <strong class="unknown">Not a known library</strong>
                    }
                  </p>
                  <button class="btn" type="button" [attr.aria-expanded]="openAsset() === lib.id" (click)="toggleAsset(lib.id)">
                    {{ openAsset() === lib.id ? 'Hide source' : 'Show source' }}<span class="sr-only"> of library {{ lib.id.slice(0, 8) }}</span>
                  </button>
                </li>
              }
            </ul>
          }
          @case ('files') {
            @if (files().length === 0) {
              <p class="muted">This component reads no files.</p>
            }
            <ul class="assets">
              @for (file of files(); track file.id) {
                <li>
                  <p>
                    <code>{{ file.id }}</code> — {{ file.mime }}, {{ file.size }} bytes
                  </p>
                  <button class="btn" type="button" [attr.aria-expanded]="openAsset() === file.id" (click)="toggleAsset(file.id)">
                    {{ openAsset() === file.id ? 'Hide content' : 'Show content' }}<span class="sr-only"> of file {{ file.id.slice(0, 8) }}</span>
                  </button>
                </li>
              }
            </ul>
          }
          @default {
            <div class="bar">
              <button class="btn" type="button" (click)="searchBox()?.search()">Search</button>
              <button class="btn" type="button" [attr.aria-pressed]="formatted()" (click)="formatted.set(!formatted())">Format</button>
              <span class="muted">
                {{ formatted() ? 'Showing a formatted copy (view only).' : 'Showing the source as it is.' }}
              </span>
            </div>
            <!-- CodeMirror reads its language and label once, so each tab gets its own viewer -->
            @for (key of [tab()]; track key) {
              <app-code-mirror #box class="viewer" [readOnly]="true" [language]="language()" [label]="label(tab()) + ' source, read only'" [value]="shown()" />
            }
          }
        }
        @if ((tab() === 'libs' || tab() === 'files') && openAsset()) {
          <div class="bar">
            <button class="btn" type="button" (click)="assetBox()?.search()">Search</button>
            <button class="btn" type="button" [attr.aria-pressed]="formatted()" (click)="formatted.set(!formatted())">Format</button>
            @if (assetNote(); as note) {
              <span class="muted" role="status">{{ note }}</span>
            }
          </div>
          <app-code-mirror #assetViewer class="viewer" [readOnly]="true" language="js" label="Library or file source, read only" [value]="assetShown()" />
        }
      </div>
    </div>
  `,
  styleUrl: '../editor/tools-dialog.css',
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .inspector,
    .panel {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      gap: 0.35rem;
    }
    .panel {
      overflow-y: auto;
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
    }
    .viewer {
      flex: 1 1 auto;
      min-height: 16rem;
    }
    h3 {
      margin: 0.5rem 0 0.15rem;
      font-size: 0.95rem;
    }
    .diff {
      border: 1px solid var(--border);
      border-radius: 0.25rem;
      font: 0.85rem ui-monospace, Consolas, monospace;
      overflow-x: auto;
    }
    .line {
      display: flex;
      gap: 0.5rem;
      padding: 0 0.5rem;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .line.add {
      background: var(--success-subtle);
      color: var(--text);
    }
    .line.del {
      background: var(--danger-subtle);
      color: var(--text);
    }
    .line.fold {
      background: var(--surface-sunken);
      color: var(--text-muted);
      font-style: italic;
    }
    .mark {
      flex: none;
      width: 1ch;
    }
    .assets {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 0.5rem;
    }
    .assets p {
      margin: 0 0 0.25rem;
      word-break: break-all;
    }
    .known {
      color: var(--success-ink);
    }
    .unknown {
      color: var(--warning-ink);
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
export class CodeInspector {
  /** The component to read. Only its text is used. */
  readonly component = input.required<ComponentDef>();
  /** The version the user trusted before, if any; the inspector opens on the changes against it. */
  readonly base = input<ComponentSnapshot | null>(null);
  readonly libraries = input<readonly LibraryInfo[]>([]);
  readonly fileList = input<readonly FileInfo[]>([]);
  readonly readAsset = input<AssetText>(async () => null);

  protected readonly formatted = signal(false);
  protected readonly openAsset = signal<string | null>(null);
  protected readonly assetText = signal<string | null>(null);
  protected readonly assetNote = signal<string | null>(null);
  protected readonly searchBox = viewChild<CodeMirror>('box');
  protected readonly assetBox = viewChild<CodeMirror>('assetViewer');
  private assetRequest = 0;

  private readonly snapshot = computed(() => snapshotOf(this.component()));
  protected readonly sections = computed(() => {
    const base = this.base();
    return base ? sectionsOf(base, this.snapshot()) : [];
  });
  protected readonly libs = computed(() => this.libraries());
  protected readonly files = computed(() => this.fileList());
  protected readonly tabs = computed<InspectorTab[]>(() => {
    const base = this.base() ? (['changes'] as const) : [];
    return [...base, 'html', 'css', 'js', 'props', 'libs', 'files'];
  });

  private readonly chosen = signal<InspectorTab | null>(null);
  /** Opens on the changes when there are some, else on the HTML. */
  protected readonly tab = computed<InspectorTab>(() => {
    const chosen = this.chosen();
    if (chosen && this.tabs().includes(chosen)) return chosen;
    return this.base() && this.sections().length > 0 ? 'changes' : 'html';
  });

  protected readonly language = computed<CodeLanguage>(() => {
    const tab = this.tab();
    return tab === 'html' || tab === 'css' || tab === 'js' ? tab : 'js';
  });

  protected readonly shown = computed(() => {
    const snapshot = this.snapshot();
    const tab = this.tab();
    const text = tab === 'html' ? snapshot.html : tab === 'css' ? snapshot.css : tab === 'js' ? snapshot.js : tab === 'props' ? snapshot.props : '';
    return this.formatted() ? formatForViewing(text, this.language()) : text;
  });

  protected readonly assetShown = computed(() => {
    const text = this.assetText() ?? '';
    return this.formatted() ? formatForViewing(text, 'js') : text;
  });

  constructor() {
    // Another component, or another tab, must not keep showing a file of the one before.
    const componentId = computed(() => this.component().id);
    effect(() => {
      componentId();
      untracked(() => this.closeAsset());
    });
    effect(() => {
      this.tab();
      untracked(() => this.closeAsset());
    });
  }

  protected label(id: InspectorTab): string {
    return TAB_LABELS[id];
  }

  protected select(id: InspectorTab): void {
    this.chosen.set(id);
  }

  /** Arrow keys, Home and End move between the tabs (WAI-ARIA tabs); the focus follows the selection. */
  protected onTabKey(event: KeyboardEvent): void {
    const tabs = this.tabs();
    const at = tabs.indexOf(this.tab());
    const to = event.key === 'ArrowRight' ? (at + 1) % tabs.length : event.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    this.chosen.set(tabs[to]);
    const list = (event.currentTarget as HTMLElement).parentElement;
    queueMicrotask(() => list?.querySelector<HTMLElement>(`#inspect-tab-${tabs[to]}`)?.focus());
  }

  protected async toggleAsset(id: string): Promise<void> {
    if (this.openAsset() === id) return this.closeAsset();
    const request = ++this.assetRequest;
    this.openAsset.set(id);
    this.assetText.set('');
    this.assetNote.set('Loading…');
    let text: string | null;
    try {
      text = await this.readAsset()(id);
    } catch {
      text = null;
    }
    if (request !== this.assetRequest) return;
    if (text === null) {
      this.assetText.set('');
      this.assetNote.set('This file is not text, or it could not be read.');
    } else if (text.length > MAX_ASSET_TEXT) {
      this.assetText.set('');
      this.assetNote.set('This file is too large to show.');
    } else {
      this.assetText.set(text);
      this.assetNote.set(null);
    }
  }

  private closeAsset(): void {
    this.assetRequest++;
    this.openAsset.set(null);
    this.assetText.set(null);
    this.assetNote.set(null);
  }
}
