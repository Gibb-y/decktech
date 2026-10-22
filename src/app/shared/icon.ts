import { Component, computed, input } from '@angular/core';
import { ICONS, type IconName } from './icons';

/**
 * A decorative icon: `aria-hidden`, so the control around it must have an accessible name (visible text,
 * `aria-label` or `appTooltip`). Sized by the font size of its parent (`.icon` in ui.css).
 */
@Component({
  selector: 'app-icon',
  template: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path [attr.d]="path()" /></svg>`,
  host: { style: 'display: inline-flex' },
})
export class Icon {
  readonly name = input.required<IconName>();
  protected readonly path = computed(() => (Object.hasOwn(ICONS, this.name()) ? ICONS[this.name()] : ''));
}
