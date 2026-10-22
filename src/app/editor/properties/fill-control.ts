import { Component, computed, input, output } from '@angular/core';
import type { Color, Fill, Theme } from '../../core/model';
import { ColorControl } from './color-control';

let nextId = 0;

/**
 * Picks a fill: none or a solid colour. Gradient and image fills can come from imported decks; they
 * are shown (so the control does not lie about the state) and kept until the author chooses another
 * kind, but they cannot be created here yet.
 */
@Component({
  selector: 'app-fill-control',
  imports: [ColorControl],
  template: `
    <div class="field">
      <label [for]="id">{{ label() }}</label>
      <select class="input" [id]="id" (change)="onKind($event)">
        @if (optional()) {
          <option value="none" [selected]="kind() === 'none'">{{ noneLabel() }}</option>
        }
        <option value="solid" [selected]="kind() === 'solid'">Solid colour</option>
        @if (kind() === 'gradient' || kind() === 'image') {
          <option [value]="kind()" selected>{{ kind() === 'gradient' ? 'Gradient (kept)' : 'Image (kept)' }}</option>
        }
      </select>
      @if (solid(); as color) {
        <app-color-control [label]="label() + ' colour'" [value]="color" [theme]="theme()" (changed)="onColor($event)" />
      }
    </div>
  `,
  styles: `
    .field {
      display: grid;
      gap: 0.35rem;
    }
    label {
      font-size: 0.875rem;
    }
  `,
})
export class FillControl {
  readonly label = input.required<string>();
  readonly value = input<Fill | undefined>(undefined);
  readonly theme = input.required<Theme>();
  readonly optional = input(false);
  /** What "no fill" means for this fill, e.g. "None" or "Layout background". */
  readonly noneLabel = input('None');

  readonly changed = output<Fill | undefined>();

  protected readonly id = `fill-control-${nextId++}`;
  protected readonly kind = computed(() => this.value()?.kind ?? 'none');
  protected readonly solid = computed<Color | undefined>(() => {
    const fill = this.value();
    return fill?.kind === 'solid' ? fill.color : undefined;
  });

  protected onKind(event: Event): void {
    const kind = (event.target as HTMLSelectElement).value;
    if (kind === 'none') this.changed.emit(undefined);
    else if (kind === 'solid') this.changed.emit({ kind: 'solid', color: { token: this.defaultToken() } });
    // "gradient" / "image" is the kept fill itself: nothing to change.
  }

  /** The theme's accent colour for a new solid fill, or whatever colour it has first. */
  private defaultToken(): string {
    const names = Object.keys(this.theme().colors);
    return names.includes('accent') ? 'accent' : (names[0] ?? 'accent');
  }

  protected onColor(color: Color | undefined): void {
    if (color !== undefined) this.changed.emit({ kind: 'solid', color });
  }
}
