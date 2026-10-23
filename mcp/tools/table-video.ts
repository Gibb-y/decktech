import { z } from 'zod';
import { DEFAULT_VALIDATION_OPTIONS, createElement, type Deck } from '../../src/app/core/model';
import { assetRef } from '../../src/app/core/persistence/assets';
import type { Command } from '../../src/app/core/store/command';
import { AddAsset, AddElement } from '../../src/app/core/store/commands';
import {
  AddTableColumn,
  AddTableRow,
  RemoveTableColumn,
  RemoveTableRow,
  SetTableCell,
  SetTableCellFill,
  SetTableColumnWidths,
} from '../../src/app/core/store/table-commands';
import { elementOf, elementSummary, slideOf } from '../summary';
import { ToolError, defineTool } from '../tool';
import { deckId } from './deck';
import {
  IMAGE_MIMES,
  color,
  elementId,
  geometry,
  given,
  loadAsset,
  slideId,
  toColor,
} from './elements';

const VIDEO_MIMES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Videos are bigger than pictures; the whole deck is still capped by the session budget. */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

const MAX_CELLS = DEFAULT_VALIDATION_OPTIONS.maxTableCells;

const index = z.number().int().min(0);

/** One edit of a table; `edit_table` applies a list of them as one undo step. */
const tableEdit = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_cell'), row: index, col: index, text: z.string().max(10_000) }),
  z.object({
    op: z.literal('set_cell_fill'),
    row: index,
    col: index,
    fill: color.nullable().describe('null clears the cell background.'),
  }),
  z.object({
    op: z.literal('add_row'),
    at: index.describe('Row index to insert before; the row count appends.'),
  }),
  z.object({ op: z.literal('remove_row'), at: index }),
  z.object({
    op: z.literal('add_column'),
    at: index.describe('Column index to insert before; the column count appends.'),
  }),
  z.object({ op: z.literal('remove_column'), at: index }),
  z.object({
    op: z.literal('set_column_widths'),
    widths: z
      .array(z.number().positive())
      .max(1000)
      .nullable()
      .describe('One relative width per column; null makes them equal.'),
  }),
]);

type TableEdit = z.infer<typeof tableEdit>;

function toCommand(deck: Deck, id: string, edit: TableEdit): Command {
  switch (edit.op) {
    case 'set_cell':
      return new SetTableCell(id, edit.row, edit.col, edit.text);
    case 'set_cell_fill':
      return new SetTableCellFill(
        id,
        edit.row,
        edit.col,
        edit.fill === null ? undefined : toColor(deck, edit.fill),
      );
    case 'add_row':
      return new AddTableRow(id, edit.at);
    case 'remove_row':
      return new RemoveTableRow(id, edit.at);
    case 'add_column':
      return new AddTableColumn(id, edit.at);
    case 'remove_column':
      return new RemoveTableColumn(id, edit.at);
    case 'set_column_widths':
      return new SetTableColumnWidths(id, edit.widths ?? undefined);
  }
}

export const tableVideoTools = [
  defineTool({
    name: 'add_table',
    title: 'Add table',
    description:
      'Adds a table of plain-text cells. rows is a rectangle: every row has the same number of cells. With header: true (the default) the first row is a header row, read as column headers by screen readers; pass false only when the first row is data. columnWidths are relative widths, one per column. Change it later with edit_table.',
    input: z.object({
      deckId,
      slideId,
      rows: z
        .array(z.array(z.string().max(2000)).min(1).max(50))
        .min(1)
        .max(200),
      header: z.boolean().default(true),
      columnWidths: z.array(z.number().positive()).max(50).optional(),
      ...geometry,
    }),
    run(workspace, { deckId, slideId, rows, header, columnWidths, x, y, w, h }) {
      const session = workspace.get(deckId);
      slideOf(session.deck, slideId);
      const columns = rows[0].length;
      const ragged = rows.findIndex((r) => r.length !== columns);
      if (ragged !== -1)
        throw new ToolError(
          `Every row needs ${columns} cells like the first row; row ${ragged} has ${rows[ragged].length}`,
        );
      if (rows.length * columns > MAX_CELLS)
        throw new ToolError(`A table has at most ${MAX_CELLS} cells`);
      if (columnWidths && columnWidths.length !== columns)
        throw new ToolError(`A table with ${columns} columns needs ${columns} columnWidths`);
      const element = createElement('table', {
        rows,
        header,
        ...(columnWidths ? { columnWidths } : {}),
        ...given({ x, y, w, h }),
      });
      const next = session.apply('AddTable', new AddElement(slideId, element));
      return elementSummary(elementOf(next, element.id).element);
    },
  }),

  defineTool({
    name: 'edit_table',
    title: 'Edit table',
    description:
      'Applies a list of edits to a table in order, as one undo step; if one is refused none is applied. Operations: set_cell {row, col, text}, set_cell_fill {row, col, fill|null}, add_row/add_column {at} (inserts before; the count appends), remove_row/remove_column {at}, set_column_widths {widths|null}. Indices start at 0. A table keeps at least one row and one column. Use update_element for header, position and size.',
    input: z.object({ deckId, elementId, edits: z.array(tableEdit).min(1).max(1000) }),
    run(workspace, { deckId, elementId, edits }) {
      const session = workspace.get(deckId);
      const { element } = elementOf(session.deck, elementId);
      if (element.type !== 'table')
        throw new ToolError(`Element "${elementId}" is a ${element.type} element, not a table`);
      const next = session.apply(
        'EditTable',
        ...edits.map((edit) => toCommand(session.deck, elementId, edit)),
      );
      const table = elementOf(next, elementId).element;
      return {
        ...elementSummary(table),
        rows: table.type === 'table' ? table.rows.length : 0,
        columns: table.type === 'table' ? table.rows[0].length : 0,
      };
    },
  }),

  defineTool({
    name: 'add_video',
    title: 'Add video',
    description:
      'Adds an MP4 or WebM video from a file in the workspace folder; the file is embedded in the deck. label is the accessible name of the player and is required: say what the video shows. poster is an optional picture shown before playback. autoplay needs muted and only plays while presenting. Say what the video contains in text or speaker notes too, since a video is hard to follow without sound.',
    input: z.object({
      deckId,
      slideId,
      path: z
        .string()
        .min(1)
        .describe('Video file (.mp4 or .webm), relative to the workspace folder.'),
      label: z.string().trim().min(1).max(1000),
      poster: z
        .string()
        .min(1)
        .optional()
        .describe('Picture file for the poster, relative to the workspace folder.'),
      autoplay: z.boolean().default(false),
      loop: z.boolean().default(false),
      muted: z.boolean().default(false),
      ...geometry,
    }),
    async run(
      workspace,
      { deckId, slideId, path, label, poster, autoplay, loop, muted, x, y, w, h },
    ) {
      if (autoplay && !muted)
        throw new ToolError('Browsers only autoplay muted video: pass muted: true with autoplay');
      const session = workspace.get(deckId);
      slideOf(session.deck, slideId);
      const video = await loadAsset(
        workspace,
        session,
        path,
        VIDEO_MIMES,
        'video',
        MAX_VIDEO_BYTES,
      );
      const picture = poster
        ? await loadAsset(
            workspace,
            session,
            poster,
            IMAGE_MIMES,
            'poster',
            undefined,
            video.bytes.length,
          )
        : undefined;
      const files = [video, ...(picture ? [picture] : [])];
      const commands: Command[] = [];
      for (const f of new Map(files.map((f) => [f.hash, f])).values()) {
        if (!Object.hasOwn(session.deck.assets, f.hash))
          commands.push(new AddAsset(f.hash, assetRef(f.hash, f.mime, f.bytes.length)));
      }
      const element = createElement('video', {
        assetId: video.hash,
        label: label.trim(),
        autoplay,
        loop,
        ...(muted ? { muted } : {}),
        ...(picture ? { poster: picture.hash } : {}),
        w: 960,
        h: 540,
        ...given({ x, y, w, h }),
      });
      const next = session.apply('AddVideo', ...commands, new AddElement(slideId, element));
      // Bytes are kept only once the deck accepted the assets, so a refused change leaves nothing behind.
      for (const f of files) session.assets.set(f.hash, f.bytes);
      return {
        ...elementSummary(elementOf(next, element.id).element),
        assetId: video.hash,
        bytes: video.bytes.length,
      };
    },
  }),
];
