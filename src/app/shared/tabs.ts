import { Component, ElementRef, inject, input, model } from '@angular/core';

export interface TabItem {
  id: string;
  label: string;
}

/** Ids shared by a tab and its panel, so the consumer can put `role="tabpanel"` and `aria-labelledby` on the panel. */
export const tabId = (prefix: string, id: string): string => `${prefix}-tab-${id}`;
export const panelId = (prefix: string, id: string): string => `${prefix}-panel-${id}`;

/**
 * The tab strip of a tabbed view (WAI-ARIA tabs, automatic activation): one tab stop, Left / Right / Home / End
 * move and select. The panels belong to the consumer, which marks the active one `role="tabpanel"`,
 * `[id]="panelId(prefix, id)"` and `[attr.aria-labelledby]="tabId(prefix, id)"`.
 */
@Component({
  selector: 'app-tabs',
  template: `
    <div class="tablist" role="tablist" [attr.aria-label]="label()" (keydown)="onKeydown($event)">
      @for (tab of tabs(); track tab.id) {
        <button
          type="button"
          class="tab"
          role="tab"
          [id]="tabId(idPrefix(), tab.id)"
          [attr.aria-controls]="panelId(idPrefix(), tab.id)"
          [attr.aria-selected]="tab.id === selected()"
          [attr.tabindex]="tab.id === selected() ? 0 : -1"
          (click)="selected.set(tab.id)"
        >
          {{ tab.label }}
        </button>
      }
    </div>
  `,
})
export class Tabs {
  readonly tabs = input.required<readonly TabItem[]>();
  /** Accessible name of the tab list. */
  readonly label = input.required<string>();
  readonly idPrefix = input('tabs');
  readonly selected = model.required<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly tabId = tabId;
  protected readonly panelId = panelId;

  protected onKeydown(event: KeyboardEvent): void {
    const tabs = this.tabs();
    if (tabs.length === 0) return;
    const current = Math.max(0, tabs.findIndex((t) => t.id === this.selected()));
    const target =
      event.key === 'ArrowRight' ? (current + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (current - 1 + tabs.length) % tabs.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
      : -1;
    if (target < 0) return;
    event.preventDefault();
    const next = tabs[target];
    this.selected.set(next.id);
    this.host.querySelector<HTMLElement>(`[id="${tabId(this.idPrefix(), next.id)}"]`)?.focus();
  }
}
