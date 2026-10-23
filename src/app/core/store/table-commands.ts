import { type Color, type Deck, type Element, type TableEl } from '../model';
import { CommandError, deepEqual, resultOf, updateElements, type Command, type CommandResult } from './command';
import type { GestureOptions } from './commands';

/** Table edits keep `rows`, `columnWidths` and `cellFills` the same shape, which `validateDeck` requires. */

/** A table's size is capped by the validator (`maxTableCells`); the commands refuse a growth beyond the same limit. */
const MAX_CELLS = 10_000;

const asTable = (e: Element): TableEl => {
  if (e.type !== 'table') throw new CommandError(`Element "${e.id}" is not a table`);
  return e;
};

/** A copy of `items` with `item` inserted before `at`. */
const insertAt = <T>(items: readonly T[], at: number, item: T): T[] => [...items.slice(0, at), item, ...items.slice(at)];

const index = (value: number, size: number, what: string, allowEnd = false): void => {
  if (!Number.isInteger(value) || value < 0 || value > (allowEnd ? size : size - 1)) throw new CommandError(`${what} ${value} is out of range`);
};

abstract class TableCommand implements Command {
  abstract readonly name: string;
  readonly coalesceKey?: string;

  constructor(
    readonly elementId: string,
    options: GestureOptions = {},
  ) {
    this.coalesceKey = options.coalesceKey;
  }

  protected abstract edit(table: TableEl): TableEl;

  do(deck: Deck): CommandResult {
    return resultOf(deck, updateElements(deck, [this.elementId], (e) => this.edit(asTable(e))));
  }
}

/** Replaces the text of one cell. */
export class SetTableCell extends TableCommand {
  readonly name = 'SetTableCell';

  constructor(
    elementId: string,
    readonly row: number,
    readonly col: number,
    readonly text: string,
    options: GestureOptions = {},
  ) {
    super(elementId, options);
  }

  protected edit(table: TableEl): TableEl {
    index(this.row, table.rows.length, 'Row');
    index(this.col, table.rows[0].length, 'Column');
    if (typeof this.text !== 'string') throw new CommandError('The cell text must be a string');
    if (table.rows[this.row][this.col] === this.text) return table;
    const rows = table.rows.map((cells, r) => (r === this.row ? cells.map((c, i) => (i === this.col ? this.text : c)) : cells));
    return { ...table, rows };
  }
}

/** Sets (or, with `undefined`, clears) the background of one cell. */
export class SetTableCellFill extends TableCommand {
  readonly name = 'SetTableCellFill';

  constructor(
    elementId: string,
    readonly row: number,
    readonly col: number,
    readonly fill: Color | undefined,
  ) {
    super(elementId);
  }

  protected edit(table: TableEl): TableEl {
    index(this.row, table.rows.length, 'Row');
    index(this.col, table.rows[0].length, 'Column');
    if (this.fill !== undefined && typeof this.fill !== 'string' && (typeof this.fill !== 'object' || this.fill === null || typeof this.fill.token !== 'string')) {
      throw new CommandError('The cell fill must be a colour');
    }
    const next = this.fill ?? null;
    if (deepEqual(table.cellFills?.[this.row]?.[this.col] ?? null, next)) return table;
    const fills = table.cellFills ?? table.rows.map((cells) => cells.map((): Color | null => null));
    const cellFills = fills.map((cells, r) => (r === this.row ? cells.map((c, i) => (i === this.col ? next : c)) : cells));
    // A table without any fill left stores none, so it equals one that never had any.
    return cellFills.every((cells) => cells.every((c) => c === null)) ? withoutKey(table, 'cellFills') : { ...table, cellFills };
  }
}

/** Inserts an empty row before `at` (`rows.length` appends). */
export class AddTableRow extends TableCommand {
  readonly name = 'AddTableRow';

  constructor(
    elementId: string,
    readonly at: number,
  ) {
    super(elementId);
  }

  protected edit(table: TableEl): TableEl {
    index(this.at, table.rows.length, 'Row', true);
    const columns = table.rows[0].length;
    if ((table.rows.length + 1) * columns > MAX_CELLS) throw new CommandError(`A table has at most ${MAX_CELLS} cells`);
    const rows = insertAt(table.rows, this.at, new Array<string>(columns).fill(''));
    const next: TableEl = { ...table, rows };
    if (table.cellFills) next.cellFills = insertAt(table.cellFills, this.at, new Array<Color | null>(columns).fill(null));
    return next;
  }
}

/** Removes a row; the last row cannot be removed. */
export class RemoveTableRow extends TableCommand {
  readonly name = 'RemoveTableRow';

  constructor(
    elementId: string,
    readonly at: number,
  ) {
    super(elementId);
  }

  protected edit(table: TableEl): TableEl {
    index(this.at, table.rows.length, 'Row');
    if (table.rows.length === 1) throw new CommandError('A table needs at least one row');
    const next: TableEl = { ...table, rows: table.rows.filter((_, r) => r !== this.at) };
    if (table.cellFills) next.cellFills = table.cellFills.filter((_, r) => r !== this.at);
    return pruneFills(next);
  }
}

/** Inserts an empty column before `at` (`columns` appends); the new column gets the average width. */
export class AddTableColumn extends TableCommand {
  readonly name = 'AddTableColumn';

  constructor(
    elementId: string,
    readonly at: number,
  ) {
    super(elementId);
  }

  protected edit(table: TableEl): TableEl {
    const columns = table.rows[0].length;
    index(this.at, columns, 'Column', true);
    if (table.rows.length * (columns + 1) > MAX_CELLS) throw new CommandError(`A table has at most ${MAX_CELLS} cells`);
    const next: TableEl = { ...table, rows: table.rows.map((cells) => insertAt(cells, this.at, '')) };
    if (table.columnWidths) {
      const average = table.columnWidths.reduce((sum, w) => sum + w, 0) / columns;
      next.columnWidths = insertAt(table.columnWidths, this.at, average);
    }
    if (table.cellFills) next.cellFills = table.cellFills.map((cells) => insertAt(cells, this.at, null));
    return next;
  }
}

/** Removes a column; the last column cannot be removed. */
export class RemoveTableColumn extends TableCommand {
  readonly name = 'RemoveTableColumn';

  constructor(
    elementId: string,
    readonly at: number,
  ) {
    super(elementId);
  }

  protected edit(table: TableEl): TableEl {
    const columns = table.rows[0].length;
    index(this.at, columns, 'Column');
    if (columns === 1) throw new CommandError('A table needs at least one column');
    const next: TableEl = { ...table, rows: table.rows.map((cells) => cells.filter((_, c) => c !== this.at)) };
    if (table.columnWidths) next.columnWidths = table.columnWidths.filter((_, c) => c !== this.at);
    if (table.cellFills) next.cellFills = table.cellFills.map((cells) => cells.filter((_, c) => c !== this.at));
    return pruneFills(next);
  }
}

/** Sets the relative widths of the columns, or with `undefined` makes them equal again. */
export class SetTableColumnWidths extends TableCommand {
  readonly name = 'SetTableColumnWidths';

  constructor(
    elementId: string,
    readonly widths: readonly number[] | undefined,
    options: GestureOptions = {},
  ) {
    super(elementId, options);
  }

  protected edit(table: TableEl): TableEl {
    if (this.widths === undefined) return withoutKey(table, 'columnWidths');
    if (this.widths.length !== table.rows[0].length) throw new CommandError(`A table with ${table.rows[0].length} columns needs ${table.rows[0].length} widths`);
    if (!this.widths.every((w) => Number.isFinite(w) && w > 0)) throw new CommandError('Column widths must be positive numbers');
    return { ...table, columnWidths: [...this.widths] };
  }
}

function withoutKey(table: TableEl, key: 'cellFills' | 'columnWidths'): TableEl {
  if (!Object.hasOwn(table, key)) return table;
  const { [key]: _removed, ...rest } = table;
  return rest as TableEl;
}

/** Drops `cellFills` once no cell has a fill, so removing the last coloured row or column leaves a plain table. */
function pruneFills(table: TableEl): TableEl {
  return table.cellFills?.every((cells) => cells.every((c) => c === null)) ? withoutKey(table, 'cellFills') : table;
}
