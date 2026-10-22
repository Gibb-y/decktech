import { Component, computed, input } from '@angular/core';
import { Icon } from './icon';
import type { IconName } from './icons';

export type NoticeKind = 'info' | 'success' | 'warning' | 'danger';

const PRESENTATION: Readonly<Record<NoticeKind, { icon: IconName; prefix: string; role: 'status' | 'alert' }>> = {
  info: { icon: 'info', prefix: 'Note: ', role: 'status' },
  success: { icon: 'check-circle', prefix: 'Success: ', role: 'status' },
  warning: { icon: 'alert', prefix: 'Warning: ', role: 'alert' },
  danger: { icon: 'x-circle', prefix: 'Error: ', role: 'alert' },
};

/**
 * An inline message. The kind is never carried by colour alone: an icon and a visually hidden prefix say it too.
 * Warnings and errors are announced at once (`role="alert"`), the rest politely (`role="status"`).
 */
@Component({
  selector: 'app-notice',
  imports: [Icon],
  template: `
    <div [class]="'notice notice-' + kind()" [attr.role]="look().role">
      <app-icon class="notice-icon" [name]="look().icon" />
      <div class="notice-body"><span class="sr-only">{{ look().prefix }}</span><ng-content /></div>
    </div>
  `,
})
export class Notice {
  readonly kind = input<NoticeKind>('info');
  protected readonly look = computed(() => PRESENTATION[this.kind()]);
}
