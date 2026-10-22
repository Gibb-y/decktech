import { DOCUMENT } from '@angular/common';
import { Component, DestroyRef, ElementRef, inject, input, signal } from '@angular/core';
import { Icon } from './icon';
import type { IconName } from './icons';
import { Tooltip } from './tooltip';
import { uniqueId } from './unique-id';

const ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/**
 * An overflow / dropdown menu (WAI-ARIA menu button). The trigger is an icon button; the items are projected
 * buttons that carry `role="menuitem"` (or `menuitemradio` with `aria-checked`) and `class="menu-item"`.
 * Arrow keys, Home and End move between items, Escape closes and returns the focus to the trigger, a click
 * outside or on an item closes it. The items stay in the DOM while it is closed (hidden), so their handlers
 * and labels exist at all times.
 */
@Component({
  selector: 'app-menu',
  imports: [Icon, Tooltip],
  host: { '(keydown)': 'onKeydown($event)', '(focusout)': 'onFocusout($event)' },
  template: `
    <div class="menu-wrap">
      <button
        type="button"
        class="btn btn-quiet btn-icon"
        aria-haspopup="menu"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="menuId"
        [attr.aria-label]="label()"
        [appTooltip]="label()"
        (click)="toggle()"
      >
        <app-icon [name]="icon()" />
      </button>
      <div class="menu" role="menu" [id]="menuId" [attr.aria-label]="label()" [hidden]="!open()" (click)="onPanelClick($event)">
        <ng-content />
      </div>
    </div>
  `,
})
export class Menu {
  readonly label = input.required<string>();
  readonly icon = input<IconName>('more');

  protected readonly menuId = uniqueId('menu');
  protected readonly open = signal(false);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    const doc = inject(DOCUMENT);
    const away = (event: Event) => {
      if (this.open() && !this.host.contains(event.target as Node)) this.open.set(false);
    };
    doc.addEventListener('pointerdown', away, true);
    inject(DestroyRef).onDestroy(() => doc.removeEventListener('pointerdown', away, true));
  }

  protected toggle(): void {
    this.open.update((o) => !o);
    if (this.open()) queueMicrotask(() => this.items()[0]?.focus());
  }

  protected onPanelClick(event: Event): void {
    if (!(event.target as HTMLElement).closest(ITEMS)) return;
    // The item is about to be hidden: the focus (and so a dialog's "return focus to the opener") goes to the trigger.
    this.host.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
    this.open.set(false);
  }

  protected onFocusout(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    if (this.open() && next && !this.host.contains(next)) this.open.set(false);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (!this.open()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.open.set(false);
      this.host.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
      return;
    }
    const items = this.items();
    if (items.length === 0) return;
    const at = items.indexOf(this.host.ownerDocument.activeElement as HTMLElement);
    const target =
      event.key === 'ArrowDown' ? (at + 1) % items.length
      : event.key === 'ArrowUp' ? (at <= 0 ? items.length - 1 : at - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : -1;
    if (target < 0) return;
    event.preventDefault();
    items[target].focus();
  }

  private items(): HTMLElement[] {
    return Array.from(this.host.querySelectorAll<HTMLElement>(ITEMS)).filter((el) => !el.hasAttribute('disabled'));
  }
}
