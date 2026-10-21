import { Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, linkedSignal, signal, untracked, viewChild } from '@angular/core';
import type { Deck, Element, TextEl } from '../../core/model';
import { DeckStore, MoveElements, ResizeElements, SetProps, type ElementGeometry } from '../../core/store';
import { SlideRenderer } from '../../renderer';
import { TextEditing } from '../text/text-editing';
import { TextEditor } from '../text/text-editor';
import { TEXT_SHORTCUTS, textShortcutId } from '../text/text-shortcuts';
import { LiveAnnouncer } from '../../shared';
import { EditorActions } from '../editor-actions';
import { ShortcutRegistry } from '../shortcut-registry';
import { CANVAS_SHORTCUTS, canvasShortcutId, type ShortcutContext } from '../shortcuts';
import {
  HANDLES,
  HANDLE_IDS,
  angleTowards,
  boundsOf,
  normalizeRect,
  rectsIntersect,
  resizeBox,
  scaleInto,
  union,
  type AlignKind,
  type Box,
  type DistributeAxis,
  type HandleId,
  type Point,
  type Rect,
} from './geometry';
import { SNAP_DISTANCE_PX, snapMove, snapTargets, snapValue, type Guide, type SnapTargets } from './snapping';
import { MAX_ZOOM, MIN_ZOOM, centered, fitViewport, panBy, toStage, zoomAt, type Size, type Viewport } from './viewport';

/** Screen distance the pointer must travel before a press on an element becomes a drag. */
const DRAG_THRESHOLD_PX = 3;
const ZOOM_STEP = 1.25;
const WHEEL_ZOOM_SPEED = 0.0015;
const ROTATE_SNAP_DEGREES = 15;

interface Frame extends Box {
  /** Whether the resize handles are offered. */
  resizable: boolean;
  rotatable: boolean;
  locked: boolean;
}

type Gesture =
  | { kind: 'move'; ids: string[]; origin: Point; client: Point; bounds: Rect; targets: SnapTargets; applied: Point; key: string; hold: (() => void) | null; plainClick: string | null; editOnClick: string | null }
  | { kind: 'resize'; handle: HandleId; start: Box; items: { id: string; box: Box }[]; group: boolean; targets: SnapTargets; key: string; hold: (() => void) | null }
  | { kind: 'rotate'; id: string; center: Point; key: string; hold: (() => void) | null }
  | { kind: 'marquee'; origin: Point; base: readonly string[] }
  | { kind: 'pan'; last: Point };

let gestureCounter = 0;

/**
 * The editing canvas (arc42 §5.4): the slide drawn by `SlideRenderer` in `edit` mode with an
 * interaction overlay on top. The overlay is a plain layer of divs in stage units that owns all
 * pointer input, so iframes of code components never see it while editing. Moves, resizes and
 * rotations are dispatched as coalesced commands, one gesture being one undo step; every pointer
 * action has a keyboard counterpart in `CANVAS_SHORTCUTS` or the toolbar.
 */
@Component({
  selector: 'app-canvas',
  imports: [SlideRenderer, TextEditor],
  templateUrl: './canvas.html',
  styleUrl: './canvas.css',
})
export class Canvas {
  protected readonly store = inject(DeckStore);
  protected readonly actions = inject(EditorActions);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly registry = inject(ShortcutRegistry);
  private readonly textEditing = inject(TextEditing);

  private readonly viewportEl = viewChild.required<ElementRef<HTMLElement>>('area');

  protected readonly handleIds = HANDLE_IDS;
  protected readonly alignButtons: readonly { kind: AlignKind; label: string }[] = [
    { kind: 'left', label: 'Align left' },
    { kind: 'center', label: 'Align centres horizontally' },
    { kind: 'right', label: 'Align right' },
    { kind: 'top', label: 'Align top' },
    { kind: 'middle', label: 'Align middles vertically' },
    { kind: 'bottom', label: 'Align bottom' },
  ];
  protected readonly distributeButtons: readonly { axis: DistributeAxis; label: string }[] = [
    { axis: 'horizontal', label: 'Distribute horizontally' },
    { axis: 'vertical', label: 'Distribute vertically' },
  ];

  // -------------------------------------------------------------- viewport

  private readonly area = signal<Size>({ width: 0, height: 0 });
  private readonly mode = signal<'fit' | 'custom'>('fit');
  private readonly custom = signal<Viewport>({ zoom: 1, panX: 0, panY: 0 });

  protected readonly stage = computed(() => this.store.deck().stage);
  protected readonly slide = this.store.currentSlide;
  protected readonly theme = computed(() => this.store.deck().theme);
  protected readonly layout = computed(() => this.store.deck().layouts.find((l) => l.id === this.slide().layoutId));

  /** Zoom and pan in effect: recomputed from the area while in "fit" mode, else what the user set. */
  readonly viewport = computed<Viewport>(() => (this.mode() === 'fit' ? fitViewport(this.area(), this.stage()) : this.custom()));
  protected readonly zoomLabel = computed(() => `${Math.round(this.viewport().zoom * 100)}%`);
  protected readonly inverseZoom = computed(() => 1 / this.viewport().zoom);
  protected readonly fitting = computed(() => this.mode() === 'fit');

  // ------------------------------------------------------------- selection

  protected readonly selection = this.store.selection;
  protected readonly hasSelection = computed(() => this.selection().length > 0);
  protected readonly selectedIds = computed(() => new Set(this.selection()));

  /** The one selected code element, if any: the only thing "interact" mode applies to. */
  private readonly interactTarget = computed(() => {
    const selected = this.store.selectedElements();
    return selected.length === 1 && selected[0].type === 'code' ? selected[0].id : null;
  });
  /** Interact mode ends whenever the selection no longer is that one code element. */
  protected readonly interact = linkedSignal<string | null, boolean>({ source: this.interactTarget, computation: () => false });

  protected readonly frame = computed<Frame | null>(() => {
    const selected = this.store.selectedElements();
    if (selected.length === 0) return null;
    const locked = selected.some((e) => e.locked);
    const interacting = this.interact();
    if (selected.length === 1) {
      const [e] = selected;
      const box = toBox(e);
      return { ...box, locked, resizable: !locked && !interacting, rotatable: !locked && !interacting };
    }
    const bounds = union(selected.map((e) => boundsOf(toBox(e))));
    // A group can be scaled as a block only while no member is turned: scaling would shear it.
    return { ...bounds, rotation: 0, locked, resizable: !locked && selected.every((e) => !e.rotation), rotatable: false };
  });

  /** The text element being edited in place, if it is still on the slide and the only thing selected. */
  protected readonly editingElement = computed<TextEl | null>(() => {
    const id = this.textEditing.editingId();
    const only = this.store.selectedElements();
    return id !== null && only.length === 1 && only[0].id === id && only[0].type === 'text' ? only[0] : null;
  });

  protected readonly guides = signal<Guide[]>([]);
  protected readonly marquee = signal<Rect | null>(null);
  protected readonly panning = signal(false);
  private spaceHeld = false;
  private gesture: Gesture | null = null;
  /** The deck when the gesture began; Escape undoes only if the gesture changed it. */
  private gestureBase: Deck | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const element = this.viewportEl().nativeElement;
      this.area.set({ width: element.clientWidth, height: element.clientHeight });
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver((entries) => {
        const rect = entries[entries.length - 1]?.contentRect;
        if (rect) this.area.set({ width: rect.width, height: rect.height });
      });
      observer.observe(element);
      destroyRef.onDestroy(() => observer.disconnect());
    });
    destroyRef.onDestroy(() => this.endGesture());
    destroyRef.onDestroy(() => this.textEditing.stop());
    // Selecting something else, or the element going away, ends the edit (the editor commits as it closes).
    effect(() => {
      if (this.textEditing.editingId() !== null && this.editingElement() === null) untracked(() => this.textEditing.stop());
    });
    const unregister = CANVAS_SHORTCUTS.map((s) =>
      this.registry.register({ ...s, id: canvasShortcutId(s), scope: 'canvas', run: (event) => s.run(this.contextFor(), event.shiftKey) }),
    );
    const unregisterText = TEXT_SHORTCUTS.map((s) =>
      this.registry.register({ ...s, id: textShortcutId(s), scope: 'text', run: () => s.run(this.textEditing) }),
    );
    destroyRef.onDestroy(() => [...unregister, ...unregisterText].forEach((u) => u()));
  }

  // ----------------------------------------------------------- view actions

  fit(): void {
    this.mode.set('fit');
  }

  /** 100%: one stage unit is one screen pixel. */
  actualSize(): void {
    this.custom.set(centered(this.area(), this.stage(), 1));
    this.mode.set('custom');
  }

  zoomBy(factor: number, anchor: Point = { x: this.area().width / 2, y: this.area().height / 2 }): void {
    const current = this.viewport();
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * factor));
    if (zoom === current.zoom) return;
    this.custom.set(zoomAt(current, zoom, anchor));
    this.mode.set('custom');
  }

  pan(dx: number, dy: number): void {
    this.custom.set(panBy(this.viewport(), dx, dy, this.area(), this.stage()));
    this.mode.set('custom');
  }

  toggleInteract(): void {
    if (this.interactTarget() === null) return void this.announcer.announce('Select one code component to interact with it');
    this.interact.update((on) => !on);
    this.announcer.announce(this.interact() ? 'Interact mode on: clicks go to the component' : 'Interact mode off');
  }

  /** Starts editing the selected text element in place (Enter, double-click, the panel's Edit text button). */
  editText(): boolean {
    const selected = this.store.selectedElements();
    if (selected.length !== 1 || selected[0].type !== 'text') return false;
    if (selected[0].locked) {
      this.announcer.announce('This element is locked. Unlock it to edit the text');
      return true;
    }
    this.textEditing.start(selected[0].id);
    return true;
  }

  /** The text element a printable key would start editing: the one selected, unlocked text element. */
  private typingTarget(): TextEl | null {
    const selected = this.store.selectedElements();
    return selected.length === 1 && selected[0].type === 'text' && !selected[0].locked ? selected[0] : null;
  }

  /** Whether the pointer would put a caret in this element: the only selected, unlocked text element. */
  protected isEditable(element: Element): boolean {
    return this.typingTarget()?.id === element.id;
  }

  protected onEditorClosed(byKeyboard: boolean): void {
    this.textEditing.stop();
    if (byKeyboard) this.viewportEl().nativeElement.focus();
  }

  protected canInteract(): boolean {
    return this.interactTarget() !== null;
  }

  // ------------------------------------------------------------ pointer input

  private stagePoint(e: MouseEvent): Point {
    const rect = this.viewportEl().nativeElement.getBoundingClientRect();
    return toStage(this.viewport(), { x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  private snapThreshold(): number {
    return SNAP_DISTANCE_PX / this.viewport().zoom;
  }

  private startsPan(e: MouseEvent): boolean {
    return e.button === 1 || (e.button === 0 && this.spaceHeld);
  }

  protected onViewportDown(e: PointerEvent): void {
    if (this.startsPan(e)) {
      e.preventDefault();
      this.begin(e, { kind: 'pan', last: { x: e.clientX, y: e.clientY } });
      this.panning.set(true);
      return;
    }
    if (e.button !== 0) return;
    // A press on empty space: clear the selection (shift keeps it) and start a marquee.
    const base = e.shiftKey ? this.selection() : [];
    if (!e.shiftKey) this.store.clearSelection();
    this.begin(e, { kind: 'marquee', origin: this.stagePoint(e), base });
  }

  protected onElementDown(element: Element, e: PointerEvent): void {
    if (this.startsPan(e) || e.button !== 0) return;
    e.stopPropagation();
    this.viewportEl().nativeElement.focus();
    if (e.shiftKey) {
      const ids = new Set(this.selection());
      if (!ids.delete(element.id)) ids.add(element.id);
      this.store.select(this.slide().elements.filter((x) => ids.has(x.id)).map((x) => x.id));
      return this.actions.announceSelection();
    }
    const wasSelected = this.selectedIds().has(element.id);
    if (!wasSelected) {
      this.store.select([element.id]);
      this.actions.announceSelection();
    }
    const movable = this.store.selectedElements().filter((x) => !x.locked);
    if (movable.length === 0) return;
    const moving = new Set(movable.map((x) => x.id));
    const others = this.slide().elements.filter((x) => !moving.has(x.id) && !x.hidden).map((x) => boundsOf(toBox(x)));
    this.begin(e, {
      kind: 'move',
      ids: movable.map((x) => x.id),
      origin: this.stagePoint(e),
      client: { x: e.clientX, y: e.clientY },
      bounds: union(movable.map((x) => boundsOf(toBox(x)))),
      targets: snapTargets(this.stage(), others),
      applied: { x: 0, y: 0 },
      key: `drag:${++gestureCounter}`,
      hold: null,
      // Pressing one of several selected elements without dragging narrows the selection to it.
      plainClick: wasSelected && this.selection().length > 1 ? element.id : null,
      // A press-and-release on a text element that was already the only selection puts the caret in it.
      editOnClick: wasSelected && this.selection().length === 1 && element.type === 'text' && !element.locked ? element.id : null,
    });
  }

  protected onHandleDown(handle: HandleId, e: PointerEvent): void {
    const frame = this.frame();
    if (!frame || !frame.resizable || e.button !== 0) return;
    e.stopPropagation();
    this.viewportEl().nativeElement.focus();
    const selected = this.store.selectedElements();
    const others = this.slide().elements.filter((x) => !this.selectedIds().has(x.id) && !x.hidden).map((x) => boundsOf(toBox(x)));
    this.begin(e, {
      kind: 'resize',
      handle,
      start: { x: frame.x, y: frame.y, w: frame.w, h: frame.h, rotation: frame.rotation },
      items: selected.map((x) => ({ id: x.id, box: toBox(x) })),
      group: selected.length > 1,
      targets: snapTargets(this.stage(), others),
      key: `resize:${++gestureCounter}`,
      hold: null,
    });
  }

  protected onRotateDown(e: PointerEvent): void {
    const frame = this.frame();
    const [only] = this.store.selectedElements();
    if (!frame || !frame.rotatable || !only || e.button !== 0) return;
    e.stopPropagation();
    this.viewportEl().nativeElement.focus();
    this.begin(e, {
      kind: 'rotate',
      id: only.id,
      center: { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 },
      key: `rotate:${++gestureCounter}`,
      hold: null,
    });
  }

  private begin(e: PointerEvent, gesture: Gesture): void {
    this.endGesture();
    this.gesture = gesture;
    this.gestureBase = this.store.deck();
    this.viewportEl().nativeElement.setPointerCapture?.(e.pointerId ?? 1);
  }

  protected onPointerMove(e: PointerEvent): void {
    const g = this.gesture;
    if (!g) return;
    switch (g.kind) {
      case 'move':
        return this.dragMove(g, e);
      case 'resize':
        return this.dragResize(g, e);
      case 'rotate':
        return this.dragRotate(g, e);
      case 'marquee':
        return this.dragMarquee(g, e);
      case 'pan': {
        const dx = e.clientX - g.last.x;
        const dy = e.clientY - g.last.y;
        g.last = { x: e.clientX, y: e.clientY };
        return this.pan(dx, dy);
      }
    }
  }

  private dragMove(g: Extract<Gesture, { kind: 'move' }>, e: PointerEvent): void {
    if (!g.hold) {
      if (Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < DRAG_THRESHOLD_PX) return;
      g.hold = this.store.beginGesture(g.key);
      g.plainClick = null;
    }
    const p = this.stagePoint(e);
    let dx = p.x - g.origin.x;
    let dy = p.y - g.origin.y;
    let guides: Guide[] = [];
    if (!e.altKey) {
      const snap = snapMove({ ...g.bounds, x: g.bounds.x + dx, y: g.bounds.y + dy }, g.targets, this.snapThreshold());
      dx += snap.dx;
      dy += snap.dy;
      guides = snap.guides;
    }
    this.guides.set(guides);
    const stepX = dx - g.applied.x;
    const stepY = dy - g.applied.y;
    if (stepX === 0 && stepY === 0) return;
    this.store.execute(new MoveElements(g.ids, stepX, stepY, { coalesceKey: g.key }));
    g.applied = { x: dx, y: dy };
  }

  private dragResize(g: Extract<Gesture, { kind: 'resize' }>, e: PointerEvent): void {
    g.hold ??= this.store.beginGesture(g.key);
    let p = this.stagePoint(e);
    const guides: Guide[] = [];
    if (g.start.rotation === 0 && !e.altKey) {
      // Only the edges the handle drags can snap; a rotated box has no edges parallel to the guides.
      const t = this.snapThreshold();
      const { sx, sy } = HANDLES[g.handle];
      if (sx) {
        const x = snapValue(p.x, g.targets.xs, t);
        if (x !== p.x) guides.push({ axis: 'x', position: x });
        p = { ...p, x };
      }
      if (sy) {
        const y = snapValue(p.y, g.targets.ys, t);
        if (y !== p.y) guides.push({ axis: 'y', position: y });
        p = { ...p, y };
      }
    }
    this.guides.set(guides);
    const box = resizeBox(g.start, g.handle, p, { keepRatio: e.shiftKey });
    const changes: ElementGeometry[] = g.group
      ? g.items.map(({ id, box: item }) => {
          const { x, y, w, h } = scaleInto(item, g.start, box);
          return { id, x, y, w, h };
        })
      : g.items.map(({ id }) => ({ id, x: box.x, y: box.y, w: box.w, h: box.h }));
    this.store.execute(new ResizeElements(changes, { coalesceKey: g.key }));
  }

  private dragRotate(g: Extract<Gesture, { kind: 'rotate' }>, e: PointerEvent): void {
    g.hold ??= this.store.beginGesture(g.key);
    const angle = angleTowards(g.center, this.stagePoint(e), e.shiftKey ? ROTATE_SNAP_DEGREES : 0);
    this.store.execute(new SetProps([g.id], { rotation: angle }, { coalesceKey: g.key }));
  }

  private dragMarquee(g: Extract<Gesture, { kind: 'marquee' }>, e: PointerEvent): void {
    const rect = normalizeRect(g.origin, this.stagePoint(e));
    this.marquee.set(rect);
    const hit = new Set(g.base);
    for (const element of this.slide().elements) {
      if (rectsIntersect(rect, boundsOf(toBox(element)))) hit.add(element.id);
    }
    this.store.select(this.slide().elements.filter((x) => hit.has(x.id)).map((x) => x.id));
  }

  /** The browser took the pointer away (touch gesture, lost capture): keep what was done, select nothing new. */
  protected onPointerCancel(): void {
    this.endGesture();
  }

  /** Focus left mid-gesture or with Space down: no pointerup / keyup will arrive here. */
  protected onBlur(): void {
    this.spaceHeld = false;
    this.endGesture();
  }

  protected onPointerUp(e: PointerEvent): void {
    const g = this.gesture;
    if (!g) return;
    this.endGesture();
    this.viewportEl().nativeElement.releasePointerCapture?.(e.pointerId ?? 1);
    if (g.kind === 'move' && g.editOnClick && !g.hold) {
      this.textEditing.start(g.editOnClick, { at: { x: e.clientX, y: e.clientY } });
    } else if (g.kind === 'move' && g.plainClick) {
      this.store.select([g.plainClick]);
      this.actions.announceSelection();
    } else if (g.kind === 'marquee') {
      this.actions.announceSelection();
    }
  }

  /** Releases the history hold and clears gesture visuals. The recorded commands stay. */
  private endGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    if (g && 'hold' in g) g.hold?.();
    this.guides.set([]);
    this.marquee.set(null);
    this.panning.set(false);
  }

  /** Escape during a drag puts everything back: the gesture's single undo step is undone. */
  private cancelGesture(): void {
    const g = this.gesture;
    if (!g) return;
    // A drag that never changed anything (no movement past the threshold, or a no-op resize) has
    // no history entry of its own, so undoing would take back an earlier edit.
    const changed = this.store.deck() !== this.gestureBase;
    this.endGesture();
    if (changed) this.store.undo();
    this.announcer.announce('Cancelled');
  }

  protected onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = this.viewportEl().nativeElement.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * WHEEL_ZOOM_SPEED), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    } else {
      this.pan(-e.deltaX, -e.deltaY);
    }
  }

  // -------------------------------------------------------------- keyboard

  protected onKeyDown(e: KeyboardEvent): void {
    if (e.key === ' ') {
      this.spaceHeld = true;
      return e.preventDefault();
    }
    if (e.key === 'Escape' && this.gesture) {
      e.preventDefault();
      return this.cancelGesture();
    }
    if (this.gesture) return;
    // Typing on a selected text element starts editing it with that character, unless the key is a shortcut.
    const target = this.typingTarget();
    if (target && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !this.registry.find(e, 'canvas')) {
      e.preventDefault();
      if (this.textEditing.editingId() === target.id) return this.textEditing.appendStart(e.key);
      return this.textEditing.start(target.id, { text: e.key });
    }
    this.registry.handle(e, 'canvas');
  }

  protected onKeyUp(e: KeyboardEvent): void {
    if (e.key === ' ') this.spaceHeld = false;
  }

  private contextFor(): ShortcutContext {
    return {
      actions: this.actions,
      view: {
        zoomIn: () => this.zoomBy(ZOOM_STEP),
        zoomOut: () => this.zoomBy(1 / ZOOM_STEP),
        fit: () => this.fit(),
        actualSize: () => this.actualSize(),
        pan: (dx, dy) => this.pan(dx, dy),
        toggleInteract: () => this.toggleInteract(),
        editText: () => this.editText(),
        hasSelection: this.hasSelection(),
      },
    };
  }

  // --------------------------------------------------------------- template

  protected hitStyle(element: Element): Record<string, string | null> {
    return {
      left: `${element.x}px`,
      top: `${element.y}px`,
      width: `${element.w}px`,
      height: `${element.h}px`,
      transform: element.rotation ? `rotate(${element.rotation}deg)` : null,
    };
  }

  protected frameStyle(frame: Frame): Record<string, string | null> {
    return {
      left: `${frame.x}px`,
      top: `${frame.y}px`,
      width: `${frame.w}px`,
      height: `${frame.h}px`,
      transform: frame.rotation ? `rotate(${frame.rotation}deg)` : null,
    };
  }

  protected marqueeStyle(rect: Rect): Record<string, string> {
    return { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` };
  }

  protected isInteracting(element: Element): boolean {
    return this.interact() && this.interactTarget() === element.id;
  }
}

function toBox(e: Element): Box {
  return { x: e.x, y: e.y, w: e.w, h: e.h, rotation: e.rotation };
}
