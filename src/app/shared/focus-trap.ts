import { DestroyRef, Directive, ElementRef, afterNextRender, inject } from '@angular/core';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab and Shift+Tab inside the host (dialogs). Focus moves into the host when it appears
 * (the first element marked `data-autofocus`, else the first focusable one, else the host itself)
 * and returns to the previously focused element when the host is destroyed.
 */
@Directive({
  selector: '[appFocusTrap]',
  host: {
    tabindex: '-1',
    '(keydown)': 'onKeydown($event)',
  },
})
export class FocusTrap {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.previous?.isConnected) this.previous.focus();
    });
    afterNextRender(() => {
      const target = this.host.querySelector<HTMLElement>('[data-autofocus]') ?? this.focusable()[0] ?? this.host;
      target.focus();
    });
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const items = this.focusable();
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === this.host)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private focusable(): HTMLElement[] {
    return Array.from(this.host.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hidden);
  }
}
