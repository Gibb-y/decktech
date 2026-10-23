import { Component, computed } from '@angular/core';
import { contrastRatio, type Color, type TableEl, type Theme } from '../core/model';
import { ElementView } from './element-view';
import { resolveColor } from './theme';

interface Cell {
  text: string;
  style: Record<string, string>;
}

interface TableView {
  /** Percentage width of each column. */
  widths: number[];
  head: Cell[] | null;
  body: Cell[][];
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The hex value of a colour that is a hex literal or a theme token with a hex value; `null` otherwise (not measurable). */
function hexOf(color: Color, theme: Theme): string | null {
  const value = typeof color === 'string' ? color : Object.hasOwn(theme.colors, color.token) ? theme.colors[color.token] : undefined;
  return typeof value === 'string' && HEX.test(value) ? value : null;
}

/**
 * Text colour for a filled cell: the theme's text or background colour, whichever contrasts more
 * with the fill, so a dark fill never swallows the text (WCAG AA, arc42 §8.8). `null` keeps the
 * inherited colour when the fill or the theme colours are not plain hex values.
 */
export function readableOn(fill: Color, theme: Theme): string | null {
  const fillHex = hexOf(fill, theme);
  const text = hexOf({ token: 'text' }, theme);
  const background = hexOf({ token: 'background' }, theme);
  if (!fillHex || !text || !background) return null;
  return contrastRatio(text, fillHex) >= contrastRatio(background, fillHex) ? 'var(--deck-color-text)' : 'var(--deck-color-background)';
}

const rowsOf = (el: TableEl): string[][] =>
  (Array.isArray(el.rows) ? el.rows : []).filter(Array.isArray).map((row) => row.map((cell) => (typeof cell === 'string' ? cell : '')));

/**
 * A semantic `<table>`: the header row (when `header` is set) is a `<thead>` of `<th scope="col">`,
 * the rest a `<tbody>`. Cell text is bound as text, never as markup. Widths, fills and sizes are
 * read defensively, since commands do not check structured values (arc42 §8.4).
 */
@Component({
  selector: 'app-table-element',
  template: `
    @if (view(); as v) {
      <table>
        <colgroup>
          @for (width of v.widths; track $index) {
            <col [style.width.%]="width" />
          }
        </colgroup>
        @if (v.head; as head) {
          <thead>
            <tr>
              @for (cell of head; track $index) {
                <th scope="col" [style]="cell.style">{{ cell.text }}</th>
              }
            </tr>
          </thead>
        }
        <tbody>
          @for (row of v.body; track $index) {
            <tr>
              @for (cell of row; track $index) {
                <td [style]="cell.style">{{ cell.text }}</td>
              }
            </tr>
          }
        </tbody>
      </table>
    }
  `,
  styles: `
    :host {
      position: absolute;
      display: block;
      box-sizing: border-box;
      overflow: hidden;
    }
    table {
      width: 100%;
      height: 100%;
      table-layout: fixed;
      border-collapse: collapse;
      font-family: var(--deck-font-body, sans-serif);
      font-size: var(--deck-type-body, 32px);
      line-height: 1.3;
    }
    th,
    td {
      padding: 12px 16px;
      border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
      text-align: left;
      vertical-align: middle;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    th {
      font-weight: 700;
      border-bottom: 4px solid var(--deck-color-accent, currentColor);
    }
  `,
})
export class TableElement extends ElementView<TableEl> {
  protected readonly type = 'table';

  protected readonly view = computed<TableView | null>(() => {
    const el = this.element();
    if (!el) return null;
    const theme = this.theme();
    const rows = rowsOf(el);
    const columns = Math.max(0, ...rows.map((row) => row.length));
    const given = Array.isArray(el.columnWidths) && el.columnWidths.length === columns && el.columnWidths.every((w) => Number.isFinite(w) && w > 0) ? el.columnWidths : null;
    const total = given ? given.reduce((sum, w) => sum + w, 0) : columns;
    const widths = Array.from({ length: columns }, (_, c) => ((given ? given[c] : 1) / total) * 100);
    const cells = rows.map((row, r) =>
      row.map((text, c): Cell => {
        const fill = el.cellFills?.[r]?.[c];
        const background = fill ? resolveColor(fill, theme) : null;
        const color = fill && background ? readableOn(fill, theme) : null;
        return { text, style: { ...(background ? { 'background-color': background } : {}), ...(color ? { color } : {}) } };
      }),
    );
    const header = el.header === true && cells.length > 0;
    return { widths, head: header ? cells[0] : null, body: header ? cells.slice(1) : cells };
  });
}
