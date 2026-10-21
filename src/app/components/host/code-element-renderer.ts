import { Component, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import type { CodeEl, ComponentDef } from '../../core/model';
import { ElementView, themeVars, type RenderMode } from '../../renderer';
import { CodeHostEvents } from './code-host-events';
import { buildDocument } from './document-builder';
import { HostApi } from './host-api';
import { ComponentAssets, ComponentPolicy, ComponentStateStore, HostConsole, LinkGuard, RuntimeSource } from './host-services';
import { API_VERSION, normalizeOrigin, type HostMessage, type LibPayload } from './protocol';
import { resolveProps } from './props';
import { createSandboxFrame } from './sandbox';
import { SANDBOX_CHANNEL, SandboxSupervisor, type SupervisorState } from './supervisor';

const sameRecord = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/**
 * Draws a `CodeEl` as a sandboxed web page (arc42 §5.3). Registered with the renderer through
 * `CODE_ELEMENT_VIEW`. In `edit` and `present` mode it creates one frame per element from the
 * component definition and keeps it in step with the deck: a change to the source, libraries or
 * permissions builds a new frame (6.2), a change to props, theme or size is sent to the running
 * one. Thumbnails get a labelled placeholder and no frame (R3). A frame that fails or stops
 * answering is replaced by a message: with the reason and a reload button in the editor, neutral
 * when presenting (6.5).
 */
@Component({
  selector: 'app-code-element',
  template: `
    @if (definition(); as def) {
      @if (mode() === 'thumbnail') {
        <div class="placeholder" role="img" [attr.aria-label]="'Code component: ' + def.name">{{ def.name }}</div>
      } @else {
        <div #slot class="slot"></div>
        @if (problem(); as text) {
          <div class="notice" [attr.role]="mode() === 'edit' ? 'alert' : 'status'">
            @if (mode() === 'edit') {
              <p>{{ text }}</p>
              <button type="button" (click)="reload()">Reload component</button>
            } @else {
              <p>This component is unavailable.</p>
            }
          </div>
        }
        @if (mode() === 'edit' && scriptError(); as message) {
          <p class="script-error" role="status">Script error: {{ message }}</p>
        }
      }
    } @else if (element()) {
      <div class="placeholder" role="img" aria-label="Missing code component">Missing component</div>
    }
  `,
  styles: `
    :host {
      position: absolute;
      display: block;
      box-sizing: border-box;
      overflow: hidden;
    }
    :host(.ghost) {
      opacity: 0.35;
    }
    .slot,
    .slot ::ng-deep iframe {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
    }
    .placeholder,
    .notice {
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      width: 100%;
      height: 100%;
      padding: 24px;
      font: 32px var(--deck-font-body, sans-serif);
      text-align: center;
      color: var(--deck-color-text, #111111);
      background: color-mix(in srgb, currentColor 10%, transparent);
    }
    .notice {
      position: absolute;
      inset: 0;
      background: color-mix(in srgb, var(--deck-color-background, #ffffff) 92%, transparent);
    }
    .notice p {
      margin: 0;
    }
    .notice button {
      font: inherit;
      padding: 4px 16px;
    }
    .script-error {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      margin: 0;
      padding: 8px 16px;
      font: 24px var(--deck-font-mono, monospace);
      color: #ffffff;
      background: #a40000;
    }
  `,
  host: {
    '[class.ghost]': 'ghost()',
    '[attr.aria-hidden]': 'ghost() ? "true" : null',
    // A hidden element is only shown dimmed in the editor: its frame must not stay a tab stop.
    '[attr.inert]': 'ghost() ? "" : null',
  },
})
export class CodeElementRenderer extends ElementView<CodeEl> {
  protected readonly type = 'code';
  readonly mode = input<RenderMode>('present');
  readonly components = input<readonly ComponentDef[]>([]);
  readonly deckId = input<string>('');
  readonly ghost = input<boolean>(false);

  private readonly document = inject(DOCUMENT);
  private readonly runtimeSource = inject(RuntimeSource);
  private readonly policy = inject(ComponentPolicy);
  private readonly stateStore = inject(ComponentStateStore);
  private readonly assets = inject(ComponentAssets);
  private readonly links = inject(LinkGuard);
  private readonly hostConsole = inject(HostConsole);
  private readonly events = inject(CodeHostEvents);
  private readonly channel = inject(SANDBOX_CHANNEL, { optional: true });

  private readonly slot = viewChild<ElementRef<HTMLElement>>('slot');
  private readonly runtime = signal<string | null>(null);
  private readonly runtimeError = signal<string | null>(null);
  private readonly reloads = signal(0);
  private readonly supervisorState = signal<SupervisorState>({ status: 'starting' });
  protected readonly scriptError = signal<string | null>(null);

  protected readonly definition = computed(() => {
    const el = this.element();
    return el ? this.components().find((def) => def.id === el.componentId) : undefined;
  });

  private readonly props = computed(() => {
    const def = this.definition();
    return def ? resolveProps(def, this.element()?.props ?? {}) : {};
  }, { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  /** Asset ids chosen in the properties panel (props of type `asset`); the component may read those too. */
  private readonly assetProps = computed(() => {
    const def = this.definition();
    const props = this.props();
    return new Set(def ? def.propSchema.flatMap((spec) => (spec.type === 'asset' && typeof props[spec.key] === 'string' ? [props[spec.key] as string] : [])) : []);
  });
  private readonly vars = computed(() => themeVars(this.theme()), { equal: sameRecord });
  private readonly size = computed(() => ({ w: this.frame().w, h: this.frame().h }), { equal: (a, b) => a.w === b.w && a.h === b.h });
  /** Libraries and files are read when the frame starts, so a change to them needs a new frame. */
  private readonly assetKey = computed(() => {
    const def = this.definition();
    return def ? `${def.libs.join(',')}|${def.files.join(',')}` : '';
  });
  private readonly frameMode = computed<'edit' | 'present'>(() => (this.mode() === 'edit' ? 'edit' : 'present'));

  /** Allowed network origins: the component must ask (permission) and the policy must grant. */
  private readonly origins = computed(() => {
    const def = this.definition();
    if (!def || !def.permissions.includes('network')) return [];
    return this.policy.networkOrigins(def).flatMap((origin) => normalizeOrigin(origin) ?? []);
  });

  /**
   * The frame's document. A string, so it only changes (and the frame is only rebuilt) when the
   * source, permissions or runtime change; the theme and props at the time of building are read
   * untracked, later changes are sent to the running frame.
   */
  private readonly srcdoc = computed(() => {
    const def = this.definition();
    const runtime = this.runtime();
    if (!def || runtime === null || this.mode() === 'thumbnail') return null;
    return buildDocument({ def, runtime, themeVars: untracked(this.vars), networkOrigins: this.origins() });
  });

  protected readonly problem = computed(() => {
    const runtimeError = this.runtimeError();
    if (runtimeError) return runtimeError;
    const state = this.supervisorState();
    return state.status === 'failed' || state.status === 'unresponsive' ? (state.reason ?? 'The component stopped.') : null;
  });

  private supervisor: SandboxSupervisor | null = null;
  private sentProps: Record<string, unknown> = {};

  constructor() {
    super();
    this.loadRuntime();

    effect((onCleanup) => {
      const slot = this.slot()?.nativeElement;
      const srcdoc = this.srcdoc();
      this.reloads();
      this.assetKey();
      this.frameMode();
      if (!slot || srcdoc === null) return;
      untracked(() => this.start(slot, srcdoc));
      onCleanup(() => this.stop(slot));
    });

    effect(() => {
      const props = this.props();
      untracked(() => {
        if (props !== this.sentProps) this.supervisor?.send({ type: 'props', props });
        this.sentProps = props;
      });
    });
    effect(() => {
      const theme = this.vars();
      untracked(() => this.supervisor?.send({ type: 'theme', theme }));
    });
    effect(() => {
      const size = this.size();
      untracked(() => this.supervisor?.send({ type: 'size', size }));
    });
    effect(() => {
      const index = this.events.stepIndexes().get(this.elementId());
      if (index !== undefined) untracked(() => this.supervisor?.send({ type: 'step', index }));
    });
  }

  protected reload(): void {
    if (this.runtime() === null) this.loadRuntime();
    this.reloads.update((count) => count + 1);
  }

  private loadRuntime(): void {
    this.runtimeError.set(null);
    this.runtimeSource.load().then(
      (text) => this.runtime.set(text),
      (error: unknown) => this.runtimeError.set(error instanceof Error ? error.message : 'The component runtime could not be loaded'),
    );
  }

  private start(slot: HTMLElement, srcdoc: string): void {
    const def = untracked(this.definition);
    const element = untracked(this.element);
    if (!def || !element) return;
    const deckId = untracked(this.deckId);
    const mode = untracked(this.frameMode);
    const origins = untracked(this.origins);
    this.supervisorState.set({ status: 'starting' });
    this.scriptError.set(null);
    this.sentProps = untracked(this.props);

    const frame = createSandboxFrame(this.document, srcdoc, `Code component: ${def.name}`);
    const note = (level: 'log' | 'info' | 'warn' | 'error' | 'host', ...args: unknown[]) => this.hostConsole.add(def.id, level, args);
    this.supervisor = new SandboxSupervisor({
      frame,
      createChannel: this.channel ?? undefined,
      onState: (state) => {
        this.supervisorState.set(state);
        if (state.reason) note('host', state.reason);
        // The supervisor has given up on a failed frame; it must not keep running behind the notice.
        if (state.status === 'failed') frame.remove();
      },
      onRejected: (reason) => note('host', `Message refused: ${reason}`),
      createApi: (send) =>
        new HostApi({
          send,
          mode,
          state: this.stateStore.load(deckId, element.id),
          saveState: (state) => this.stateStore.save(deckId, element.id, state),
          allowedAssets: { has: (assetId) => def.files.includes(assetId) || def.libs.includes(assetId) || this.assetProps().has(assetId) },
          readAsset: (assetId) => this.assets.read(assetId),
          networkOrigins: origins,
          onHeartbeat: () => undefined,
          onSteps: (count) => this.events.setStepCount(element.id, count),
          onNavigate: (request) => this.events.requestNavigation(element.id, request),
          onLog: (level, args) => note(level, ...args),
          onError: (message) => {
            note('error', message);
            this.scriptError.set(message);
          },
          onSnapshot: (blob) => this.events.setSnapshot(element.id, blob),
          onLink: (url) => void this.links.open(url),
        }),
      createInit: () => this.createInit(def, element.id, deckId, mode, origins.length > 0),
    });
    slot.replaceChildren(frame);
  }

  private stop(slot: HTMLElement): void {
    this.supervisor?.destroy();
    this.supervisor = null;
    slot.replaceChildren();
    this.events.release(untracked(this.elementId));
  }

  private async createInit(def: ComponentDef, elementId: string, deckId: string, mode: 'edit' | 'present', network: boolean): Promise<{ message: HostMessage; transfer: Transferable[] }> {
    const libs: LibPayload[] = [];
    for (const id of def.libs) {
      const asset = await this.assets.read(id);
      if (asset) libs.push({ id, mime: asset.mime, data: asset.data });
    }
    const message: HostMessage = {
      type: 'init',
      apiVersion: API_VERSION,
      props: untracked(this.props),
      theme: untracked(this.vars),
      mode,
      size: untracked(this.size),
      state: this.stateStore.load(deckId, elementId),
      libs,
      step: this.events.stepIndexes().get(elementId) ?? 0,
      permissions: { network },
    };
    return { message, transfer: libs.map((lib) => lib.data) };
  }
}
