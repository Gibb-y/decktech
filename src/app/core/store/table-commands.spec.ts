import { createDeck, createElement, validateDeck, type Deck, type TableEl } from '../model';
import { CommandError, type Command } from './command';
import { applyPatch } from './patch';
import { AddTableColumn, AddTableRow, RemoveTableColumn, RemoveTableRow, SetTableCell, SetTableCellFill, SetTableColumnWidths } from './table-commands';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function fixture(patch: Partial<TableEl> = {}) {
  const base = createDeck('T');
  const table = createElement('table', { rows: [['a', 'b', 'c'], ['d', 'e', 'f']], ...patch });
  const text = createElement('text', { text: 'x' });
  const deck: Deck = { ...base, slides: [{ ...base.slides[0], elements: [table, text] }] };
  return { deck: deepFreeze(deck), table, text };
}

const tableOf = (deck: Deck, id: string) => deck.slides[0].elements.find((e) => e.id === id) as TableEl;
const run = (deck: Deck, command: Command, id: string): TableEl => {
  const result = command.do(deck);
  expect(validateDeck(result.deck).ok).toBe(true);
  return tableOf(result.deck, id);
};
const error = (deck: Deck, command: Command): string => {
  try {
    command.do(deck);
  } catch (e) {
    expect(e).toBeInstanceOf(CommandError);
    return (e as Error).message;
  }
  throw new Error('expected a CommandError');
};

describe('SetTableCell', () => {
  it('replaces one cell and shares every other row', () => {
    const { deck, table } = fixture();
    const next = run(deck, new SetTableCell(table.id, 1, 2, 'z'), table.id);
    expect(next.rows).toEqual([['a', 'b', 'c'], ['d', 'e', 'z']]);
    expect(next.rows[0]).toBe(table.rows[0]);
  });

  it('is a no-op for the same text and returns the same deck', () => {
    const { deck, table } = fixture();
    const result = new SetTableCell(table.id, 0, 0, 'a').do(deck);
    expect(result.deck).toBe(deck);
    expect(result.patch).toEqual([]);
  });

  it('undoes through its inverse patch', () => {
    const { deck, table } = fixture();
    const result = new SetTableCell(table.id, 0, 1, 'q').do(deck);
    expect(applyPatch(result.deck, result.inverse)).toEqual(deck);
    expect(applyPatch(deck, result.patch)).toEqual(result.deck);
  });

  it.each([
    [-1, 0, 'Row -1 is out of range'],
    [2, 0, 'Row 2 is out of range'],
    [0, 3, 'Column 3 is out of range'],
    [0, 1.5, 'Column 1.5 is out of range'],
    [Number.NaN, 0, 'Row NaN is out of range'],
  ])('refuses cell (%s, %s)', (row, col, message) => {
    const { deck, table } = fixture();
    expect(error(deck, new SetTableCell(table.id, row, col, 'x'))).toBe(message);
  });

  it('refuses a non-string text, an unknown id and an element that is not a table', () => {
    const { deck, table, text } = fixture();
    expect(error(deck, new SetTableCell(table.id, 0, 0, 5 as unknown as string))).toBe('The cell text must be a string');
    expect(error(deck, new SetTableCell('nope', 0, 0, 'x'))).toBe('Element "nope" does not exist');
    expect(error(deck, new SetTableCell(text.id, 0, 0, 'x'))).toBe(`Element "${text.id}" is not a table`);
  });

  it('keeps text such as __proto__ as plain cell text', () => {
    const { deck, table } = fixture();
    expect(run(deck, new SetTableCell(table.id, 0, 0, '__proto__'), table.id).rows[0][0]).toBe('__proto__');
  });
});

describe('SetTableCellFill', () => {
  it('creates a full-size fills grid on first use and sets a token or a literal', () => {
    const { deck, table } = fixture();
    const next = run(deck, new SetTableCellFill(table.id, 1, 0, { token: 'accent' }), table.id);
    expect(next.cellFills).toEqual([[null, null, null], [{ token: 'accent' }, null, null]]);
    expect(run(deck, new SetTableCellFill(table.id, 0, 2, '#ff0000'), table.id).cellFills?.[0][2]).toBe('#ff0000');
  });

  it('removes cellFills once the last fill is cleared, so the table equals one that never had any', () => {
    const { deck, table } = fixture();
    const filled = new SetTableCellFill(table.id, 0, 0, '#112233').do(deck).deck;
    const cleared = new SetTableCellFill(table.id, 0, 0, undefined).do(filled).deck;
    expect(tableOf(cleared, table.id)).toEqual(table);
    expect(Object.hasOwn(tableOf(cleared, table.id), 'cellFills')).toBe(false);
  });

  it('is a no-op for the same fill, including an equal token object, and for clearing nothing', () => {
    const { deck, table } = fixture({ cellFills: [[{ token: 'accent' }, null, null], [null, null, null]] });
    expect(new SetTableCellFill(table.id, 0, 0, { token: 'accent' }).do(deck).deck).toBe(deck);
    expect(new SetTableCellFill(table.id, 1, 1, undefined).do(deck).deck).toBe(deck);
  });

  it('refuses an out-of-range cell and a value that is not a colour', () => {
    const { deck, table } = fixture();
    expect(error(deck, new SetTableCellFill(table.id, 2, 0, '#fff'))).toBe('Row 2 is out of range');
    expect(error(deck, new SetTableCellFill(table.id, 0, 0, 7 as unknown as string))).toBe('The cell fill must be a colour');
    expect(error(deck, new SetTableCellFill(table.id, 0, 0, null as unknown as string))).toBe('The cell fill must be a colour');
  });
});

describe('AddTableRow / RemoveTableRow', () => {
  it.each([
    [0, [['', '', ''], ['a', 'b', 'c'], ['d', 'e', 'f']]],
    [1, [['a', 'b', 'c'], ['', '', ''], ['d', 'e', 'f']]],
    [2, [['a', 'b', 'c'], ['d', 'e', 'f'], ['', '', '']]],
  ])('inserts an empty row at %i', (at, rows) => {
    const { deck, table } = fixture();
    expect(run(deck, new AddTableRow(table.id, at), table.id).rows).toEqual(rows);
  });

  it('keeps cellFills in step with the rows, in both directions', () => {
    const { deck, table } = fixture({ cellFills: [[null, '#111111', null], [null, null, '#222222']] });
    const added = new AddTableRow(table.id, 1).do(deck).deck;
    expect(tableOf(added, table.id).cellFills).toEqual([[null, '#111111', null], [null, null, null], [null, null, '#222222']]);
    const removed = run(added, new RemoveTableRow(table.id, 0), table.id);
    expect(removed.cellFills).toEqual([[null, null, null], [null, null, '#222222']]);
  });

  it('removes a row and drops cellFills when none is left', () => {
    const { deck, table } = fixture({ cellFills: [[null, '#111111', null], [null, null, null]] });
    const next = run(deck, new RemoveTableRow(table.id, 0), table.id);
    expect(next.rows).toEqual([['d', 'e', 'f']]);
    expect(Object.hasOwn(next, 'cellFills')).toBe(false);
  });

  it('refuses a bad index, removing the last row and growing past the cell limit', () => {
    const { deck, table } = fixture();
    expect(error(deck, new AddTableRow(table.id, 3))).toBe('Row 3 is out of range');
    expect(error(deck, new RemoveTableRow(table.id, 2))).toBe('Row 2 is out of range');
    const single = fixture({ rows: [['only']] });
    expect(error(single.deck, new RemoveTableRow(single.table.id, 0))).toBe('A table needs at least one row');
    const big = fixture({ rows: Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => '')) });
    expect(error(big.deck, new AddTableRow(big.table.id, 0))).toBe('A table has at most 10000 cells');
  });
});

describe('AddTableColumn / RemoveTableColumn', () => {
  it('inserts an empty column in every row at the start, middle and end', () => {
    const { deck, table } = fixture();
    expect(run(deck, new AddTableColumn(table.id, 0), table.id).rows).toEqual([['', 'a', 'b', 'c'], ['', 'd', 'e', 'f']]);
    expect(run(deck, new AddTableColumn(table.id, 2), table.id).rows).toEqual([['a', 'b', '', 'c'], ['d', 'e', '', 'f']]);
    expect(run(deck, new AddTableColumn(table.id, 3), table.id).rows).toEqual([['a', 'b', 'c', ''], ['d', 'e', 'f', '']]);
  });

  it('gives the new column the average width and keeps fills aligned', () => {
    const { deck, table } = fixture({ columnWidths: [1, 2, 3], cellFills: [['#111111', null, null], [null, null, '#222222']] });
    const next = run(deck, new AddTableColumn(table.id, 1), table.id);
    expect(next.columnWidths).toEqual([1, 2, 2, 3]);
    expect(next.cellFills).toEqual([['#111111', null, null, null], [null, null, null, '#222222']]);
  });

  it('removes a column from rows, widths and fills', () => {
    const { deck, table } = fixture({ columnWidths: [1, 2, 3], cellFills: [['#111111', null, null], [null, null, '#222222']] });
    const next = run(deck, new RemoveTableColumn(table.id, 0), table.id);
    expect(next.rows).toEqual([['b', 'c'], ['e', 'f']]);
    expect(next.columnWidths).toEqual([2, 3]);
    expect(next.cellFills).toEqual([[null, null], [null, '#222222']]);
  });

  it('refuses a bad index, removing the last column and growing past the cell limit', () => {
    const { deck, table } = fixture();
    expect(error(deck, new AddTableColumn(table.id, 4))).toBe('Column 4 is out of range');
    expect(error(deck, new RemoveTableColumn(table.id, 3))).toBe('Column 3 is out of range');
    const single = fixture({ rows: [['a'], ['b']] });
    expect(error(single.deck, new RemoveTableColumn(single.table.id, 0))).toBe('A table needs at least one column');
    const big = fixture({ rows: Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => '')) });
    expect(error(big.deck, new AddTableColumn(big.table.id, 0))).toBe('A table has at most 10000 cells');
  });
});

describe('SetTableColumnWidths', () => {
  it('sets widths and clears them with undefined', () => {
    const { deck, table } = fixture();
    const set = new SetTableColumnWidths(table.id, [1, 2, 3]).do(deck).deck;
    expect(tableOf(set, table.id).columnWidths).toEqual([1, 2, 3]);
    const cleared = run(set, new SetTableColumnWidths(table.id, undefined), table.id);
    expect(cleared).toEqual(table);
    expect(new SetTableColumnWidths(table.id, undefined).do(deck).deck).toBe(deck);
  });

  it.each([
    [[1, 2], 'A table with 3 columns needs 3 widths'],
    [[1, 0, 1], 'Column widths must be positive numbers'],
    [[1, -1, 1], 'Column widths must be positive numbers'],
    [[1, Number.NaN, 1], 'Column widths must be positive numbers'],
    [[1, Number.POSITIVE_INFINITY, 1], 'Column widths must be positive numbers'],
  ])('refuses %j', (widths, message) => {
    const { deck, table } = fixture();
    expect(error(deck, new SetTableColumnWidths(table.id, widths))).toBe(message);
  });

  it('copies the widths it is given', () => {
    const { deck, table } = fixture();
    const widths = [1, 1, 1];
    const next = run(deck, new SetTableColumnWidths(table.id, widths), table.id);
    widths[0] = 9;
    expect(next.columnWidths).toEqual([1, 1, 1]);
  });
});

describe('table commands and gestures', () => {
  it('carry the coalesce key so typing in a cell is one undo step', () => {
    const { table } = fixture();
    expect(new SetTableCell(table.id, 0, 0, 'x', { coalesceKey: 'k' }).coalesceKey).toBe('k');
    expect(new SetTableColumnWidths(table.id, [1, 1, 1], { coalesceKey: 'w' }).coalesceKey).toBe('w');
  });
});
