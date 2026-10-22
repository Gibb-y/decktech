import { DOCUMENT } from '@angular/common';
import { DestroyRef, Directive, ElementRef, afterNextRender, computed, inject, input } from '@angular/core';
import { uniqueId } from './unique-id';

const SHOW_DELAY_MS = 400;
const HIDE_DELAY_MS = 150;
const GAP_PX = 6;
const EDGE_PX = 4;

/** `Ctrl+Shift+Z` -> `Control+Shift+Z`, the spelling of `aria-keyshortcuts`. */
export function ariaKeyShortcuts(shortcut: string): string {
  return shortcut
    .split('+')
    .map((key) => ({ Ctrl: 'Control', Cmd: 'Meta', Del: 'Delete', Esc: 'Escape' })[key.trim()] ?? key.trim())
    .join('+');
}

/**
 * A tooltip for icon buttons and other controls (WCAG 1.4.13): it shows on hover after a short delay and on
 * keyboard focus, stays while the pointer is over it, and Escape dismisses it. `appTooltip` is the text,
 * `appTooltipShortcut` an optional hint such as `Ctrl+B` that is shown as `kbd` and exposed as `aria-keyshortcuts`.
 * A host without an `aria-label` and without text of its own (an icon button) gets the tooltip text as its name.
 */
@Directive({
  selector: '[appTooltip]',
  host: {
    '[attr.aria-keyshortcuts]': 'keyShortcuts()',
    '(mouseenter)': 'showSoon()',
    '(mouseleave)': 'hideSoon()',
    '(mousedown)': 'pressed = true',
    '(focus)': 'onFocus()',
    '(blur)': 'pressed = false; hide()',
    '(click)': 'hide()',
    '(keydown.escape)': 'onEscape($event)',
  },
})
export class Tooltip {
  readonly text = input.required<string>({ alias: 'appTooltip' });
  readonly shortcut = input('', { alias: 'appTooltipShortcut' });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly doc = inject(DOCUMENT);
  protected readonly keyShortcuts = computed(() => (this.shortcut() ? ariaKeyShortcuts(this.shortcut()) : null));
  private bubble: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  protected pressed = false;

  constructor() {
    afterNextRender(() => {
      if (!this.host.hasAttribute('aria-label') && !this.host.hasAttribute('aria-labelledby') && !this.host.textContent?.trim()) {
        this.host.setAttribute('aria-label', this.text());
      }
    });
    inject(DestroyRef).onDestroy(() => this.hide());
  }

  protected showSoon(): void {
    clearTimeout(this.timer);
    if (this.bubble) return;
    this.timer = setTimeout(() => this.show(), SHOW_DELAY_MS);
  }

  protected hideSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), HIDE_DELAY_MS);
  }

  protected onFocus(): void {
    // Focus that a mouse press caused: the pointer is on the control, the tooltip would only sit in the way.
    const byPointer = this.pressed;
    this.pressed = false;
    if (!byPointer) this.show();
  }

  protected onEscape(event: Event): void {
    if (!this.bubble) return;
    event.stopPropagation();
    this.hide();
  }

  hide(): void {
    clearTimeout(this.timer);
    this.bubble?.remove();
    this.bubble = null;
  }

  private show(): void {
    clearTimeout(this.timer);
    if (this.bubble || !this.text()) return;
    const bubble = this.doc.createElement('div');
    bubble.className = 'tooltip';
    bubble.id = uniqueId('tooltip');
    bubble.setAttribute('role', 'tooltip');
    bubble.append(this.text());
    if (this.shortcut()) {
      const kbd = this.doc.createElement('kbd');
      kbd.className = 'kbd';
      kbd.textContent = this.shortcut();
      bubble.append(kbd);
    }
    // The pointer may move onto the tooltip to read it.
    bubble.addEventListener('mouseenter', () => clearTimeout(this.timer));
    bubble.addEventListener('mouseleave', () => this.hideSoon());
    this.doc.body.append(bubble);
    this.place(bubble);
    this.bubble = bubble;
  }

  /** Below the host, centred and kept inside the viewport; above it when there is no room below. */
  private place(bubble: HTMLElement): void {
    const view = this.doc.defaultView;
    const anchor = this.host.getBoundingClientRect();
    const size = bubble.getBoundingClientRect();
    const width = view?.innerWidth ?? 0;
    const height = view?.innerHeight ?? 0;
    const left = Math.min(Math.max(anchor.left + anchor.width / 2 - size.width / 2, EDGE_PX), Math.max(EDGE_PX, width - size.width - EDGE_PX));
    const below = anchor.bottom + GAP_PX;
    const top = height > 0 && below + size.height > height ? Math.max(EDGE_PX, anchor.top - GAP_PX - size.height) : below;
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  }
}
