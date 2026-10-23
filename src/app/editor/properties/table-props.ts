import { Component, computed, inject, input, signal } from '@angular/core';
import type { Color, TableEl } from '../../core/model';
import {
  AddTableColumn,
  AddTableRow,
  CommandError,
  DeckStore,
  RemoveTableColumn,
  RemoveTableRow,
  SetTableCell,
  SetTableCellFill,
  SetTableColumnWidths,
  type Command,
} from '../../core/store';
import { LiveAnnouncer } from '../../shared';
import { ColorControl } from './color-control';

/**
 * The properties panel's part for a table (arc42 §5.4): the cells as a grid of text fields, add and
 * remove row or column next to the cell that has the focus, the relative column widths and the
 * fill of that cell. The header row switch is a plain schema field, shown with the others. Every
 * change is one table command, so the panel never writes the rows itself.
 */
@Component({
  selector: 'app-table-props',
  imports: [ColorControl],
  templateUrl: './table-props.html',
  styleUrl: './element-props.css',
})
export class TableProps {
  readonly element = input.required<TableEl>();

  private readonly store = inject(DeckStore);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly focused = signal({ row: 0, col: 0 });

  protected readonly locked = computed(() => this.element().locked === true);
  protected readonly rows = computed(() => this.element().rows);
  protected readonly columns = computed(() => this.element().rows[0]?.length ?? 0);
  protected readonly columnIndexes = computed(() => Array.from({ length: this.columns() }, (_, c) => c));
  protected readonly theme = computed(() => this.store.deck().theme);
  /** The cell the buttons act on: the one last focused, kept inside the table when rows or columns were removed. */
  protected readonly active = computed(() => ({
    row: Math.min(this.focused().row, this.rows().length - 1),
    col: Math.min(this.focused().col, this.columns() - 1),
  }));
  protected readonly activeFill = computed(() => this.element().cellFills?.[this.active().row]?.[this.active().col] ?? undefined);
  protected readonly activeName = computed(() => `row ${this.active().row + 1}, column ${this.active().col + 1}`);
  protected readonly widths = computed(() => this.element().columnWidths ?? this.columnIndexes().map(() => 1));

  protected focus(row: number, col: number): void {
    this.focused.set({ row, col });
  }

  protected setCell(row: number, col: number, event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.run(new SetTableCell(this.element().id, row, col, text, { coalesceKey: `table:${this.element().id}:${row}:${col}` }));
  }

  protected setFill(fill: Color | undefined): void {
    const { row, col } = this.active();
    this.run(new SetTableCellFill(this.element().id, row, col, fill));
  }

  protected addRow(): void {
    this.run(new AddTableRow(this.element().id, this.active().row + 1), () => this.focus(this.active().row + 1, this.active().col), 'Row added');
  }

  protected removeRow(): void {
    this.run(new RemoveTableRow(this.element().id, this.active().row), undefined, 'Row removed');
  }

  protected addColumn(): void {
    this.run(new AddTableColumn(this.element().id, this.active().col + 1), () => this.focus(this.active().row, this.active().col + 1), 'Column added');
  }

  protected removeColumn(): void {
    this.run(new RemoveTableColumn(this.element().id, this.active().col), undefined, 'Column removed');
  }

  protected setWidth(col: number, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value) || value <= 0) return; // the field says so (min) and keeps the last good width
    this.run(new SetTableColumnWidths(this.element().id, this.widths().map((w, c) => (c === col ? value : w)), { coalesceKey: `table-widths:${this.element().id}` }));
  }

  /** After an edit that was not applied (empty, zero, negative) the field shows the width the table really has. */
  protected showWidth(col: number, event: Event): void {
    (event.target as HTMLInputElement).value = String(this.widths()[col]);
  }

  protected equalWidths(): void {
    this.run(new SetTableColumnWidths(this.element().id, undefined), undefined, 'Columns have equal widths');
  }

  private run(command: Command, after?: () => void, message?: string): void {
    try {
      this.store.execute(command);
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      this.announcer.announce(e.message);
      return;
    }
    after?.();
    if (message) this.announcer.announce(message);
  }
}
