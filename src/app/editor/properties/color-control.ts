import { Component, computed, input, output } from '@angular/core';
import type { Color, Theme } from '../../core/model';

let nextId = 0;

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;

/** token-check-ignore: `#abc` → `#aabbcc`; anything that is not a hex colour falls back to black (a colour input needs hex). */
export function toHex(color: Color | undefined): string {
  if (typeof color !== 'string') return '#000000'; // token-check-ignore
  if (HEX6.test(color)) return color.toLowerCase();
  if (HEX3.test(color)) return `#${[...color.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  return '#000000'; // token-check-ignore
}

/**
 * Picks a colour: a token of the deck theme (the default, so a restyled theme restyles the deck) or
 * a custom colour. Optional colours can also be "None". It only reports the choice; the caller
 * decides which command stores it.
 */
@Component({
  selector: 'app-color-control',
  template: `
    <div class="field">
      <label [for]="id">{{ label() }}</label>
      <select class="input" [id]="id" (change)="onChoice($event)">
        @if (optional()) {
          <option value="none" [selected]="choice() === 'none'">None</option>
        }
        @for (token of tokens(); track token) {
          <option [value]="'token:' + token" [selected]="choice() === 'token:' + token">Theme: {{ token }}</option>
        }
        <option value="custom" [selected]="choice() === 'custom'">Custom colour</option>
      </select>
      @if (choice() === 'custom') {
        <input type="color" [attr.aria-label]="label() + ', custom colour'" [value]="hex()" (input)="onCustom($event)" />
      }
    </div>
  `,
  styles: `
    .field {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem;
    }
    label {
      flex: 1 1 100%;
      font-size: 0.875rem;
    }
  `,
})
export class ColorControl {
  readonly label = input.required<string>();
  readonly value = input<Color | undefined>(undefined);
  readonly theme = input.required<Theme>();
  /** Offer "None" and report `undefined` for it. */
  readonly optional = input(false);

  readonly changed = output<Color | undefined>();

  protected readonly id = `color-control-${nextId++}`;
  protected readonly choice = computed(() => {
    const value = this.value();
    if (value === undefined) return 'none';
    return typeof value === 'string' ? 'custom' : `token:${value.token}`;
  });
  /** The theme's colour names, plus the one in use if the theme no longer has it. */
  protected readonly tokens = computed(() => {
    const names = Object.keys(this.theme().colors);
    const value = this.value();
    return typeof value === 'object' && value !== null && !names.includes(value.token) ? [...names, value.token] : names;
  });
  protected readonly hex = computed(() => toHex(this.value()));

  protected onChoice(event: Event): void {
    const choice = (event.target as HTMLSelectElement).value;
    if (choice === 'none') this.changed.emit(undefined);
    else if (choice === 'custom') this.changed.emit(this.hex());
    else this.changed.emit({ token: choice.slice('token:'.length) });
  }

  protected onCustom(event: Event): void {
    this.changed.emit((event.target as HTMLInputElement).value);
  }
}
