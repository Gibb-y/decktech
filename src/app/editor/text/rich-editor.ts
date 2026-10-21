import { baseKeymap, setBlockType, toggleMark } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { Fragment, Slice, type MarkType, type Node as PmNode } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { EditorState, Plugin, Selection, type Command, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { RICH_LIMITS, emptyRichDoc, isSafeHref, validateRichText, type RichDoc, type RichTokens } from '../../core/model';
import type { RichCommand, RichFormat } from './rich-format';
import { richSchema as schema } from './rich-schema';

export interface RichEditorOptions {
  /** Accessible name of the editing surface. */
  label: string;
  tokens: RichTokens;
  onFormat(format: RichFormat): void;
  /** Focus left the editing surface; `to` is where it went. */
  onBlur(to: Element | null): void;
  onEscape(): void;
  /** Ctrl+K: the host asks for an address. */
  onLink(): void;
  /** A change was refused because the document would exceed the limits of the stored format. */
  onLimit(): void;
}

/**
 * Whether a document stays inside the limits `validateRichText` enforces (nodes, characters, list
 * nesting), so what the editor accepts can always be saved.
 */
function withinLimits(doc: PmNode): boolean {
  let nodes = 0;
  let characters = 0;
  const walk = (node: PmNode, listDepth: number): boolean => {
    const list = node.type === schema.nodes['bullet_list'] || node.type === schema.nodes['ordered_list'];
    const depth = listDepth + (list ? 1 : 0);
    if (depth > RICH_LIMITS.maxDepth) return false;
    let ok = true;
    node.forEach((child) => {
      if (!ok) return;
      if (++nodes > RICH_LIMITS.maxNodes) ok = false;
      else if (child.isText && (characters += child.nodeSize) > RICH_LIMITS.maxText) ok = false;
      else ok = walk(child, depth);
    });
    return ok;
  };
  return walk(doc, 0);
}

const isMark = (type: MarkType) => (state: EditorState): boolean => {
  const { from, $from, to, empty } = state.selection;
  return empty ? !!type.isInSet(state.storedMarks ?? $from.marks()) : state.doc.rangeHasMark(from, to, type);
};

/** The document as the editor starts from it: the stored JSON when it is valid, else one empty paragraph. */
function docFrom(json: RichDoc, tokens: RichTokens): PmNode {
  if (validateRichText(json, 'rich', tokens).length > 0) return schema.nodeFromJSON(emptyRichDoc());
  try {
    const doc = schema.nodeFromJSON(json);
    doc.check();
    return doc;
  } catch {
    return schema.nodeFromJSON(emptyRichDoc());
  }
}

/**
 * ProseMirror editor for one text element (ADR-004): the schema in `rich-schema.ts`, its own
 * undo history while focused, and the format commands the properties panel and keyboard call.
 * It lives in a lazy chunk; nothing in the renderer or presenter imports this file.
 */
export class RichEditor {
  readonly view: EditorView;
  private readonly initial: string;

  constructor(
    host: HTMLElement,
    doc: RichDoc,
    private readonly options: RichEditorOptions,
  ) {
    const pmDoc = docFrom(doc, options.tokens);
    this.initial = JSON.stringify(pmDoc.toJSON());
    const markKey = (type: MarkType): Command => toggleMark(type);
    const state = EditorState.create({
      doc: pmDoc,
      plugins: [
        new Plugin({
          filterTransaction: (tr) => {
            if (!tr.docChanged || withinLimits(tr.doc)) return true;
            options.onLimit();
            return false;
          },
        }),
        history(),
        keymap({
          'Mod-b': markKey(schema.marks['bold']),
          'Mod-i': markKey(schema.marks['italic']),
          'Mod-u': markKey(schema.marks['underline']),
          'Mod-`': markKey(schema.marks['code']),
          'Mod-k': () => (options.onLink(), true),
          'Mod-z': undo,
          'Mod-y': redo,
          'Mod-Shift-z': redo,
          'Mod-]': sinkListItem(schema.nodes['list_item']),
          'Mod-[': liftListItem(schema.nodes['list_item']),
          Enter: splitListItem(schema.nodes['list_item']),
          'Shift-Enter': (s, d) => (d?.(s.tr.replaceSelectionWith(schema.nodes['hard_break'].create()).scrollIntoView()), true),
        }),
        keymap(baseKeymap),
      ],
    });
    this.view = new EditorView(host, {
      state,
      // `rich` gives the surface the stylesheet the renderer uses, so editing looks like presenting.
      attributes: { class: 'rich', role: 'textbox', 'aria-multiline': 'true', 'aria-label': options.label, spellcheck: 'true' },
      dispatchTransaction: (tr: Transaction) => {
        this.view.updateState(this.view.state.apply(tr));
        options.onFormat(this.format());
      },
      // Whatever arrives from outside is parsed by the schema (unknown nodes, marks and attributes are dropped);
      // this also removes the empty-text marks a paste can leave behind.
      transformPasted: (slice) => new Slice(this.stripInvalid(slice.content), slice.openStart, slice.openEnd),
      handleDOMEvents: {
        blur: (view, event) => (options.onBlur((event as FocusEvent).relatedTarget as Element | null), false),
      },
      handleKeyDown: (_view, event) => (event.key === 'Escape' ? (options.onEscape(), true) : false),
    });
    options.onFormat(this.format());
  }

  /** Drops link marks with an unsafe address that a schema parse could not have seen (a slice built in code). */
  private stripInvalid(content: Fragment): Fragment {
    const nodes: PmNode[] = [];
    content.forEach((node) => {
      const marks = node.marks.filter((m) => m.type !== schema.marks['link'] || isSafeHref(m.attrs['href']));
      nodes.push(node.isText ? node.mark(marks) : node.copy(this.stripInvalid(node.content)));
    });
    return Fragment.fromArray(nodes);
  }

  /** The document as stored JSON. */
  json(): RichDoc {
    return this.view.state.doc.toJSON() as RichDoc;
  }

  /** Whether the content differs from what the editor started with. */
  get changed(): boolean {
    return JSON.stringify(this.json()) !== this.initial;
  }

  /** Focuses the editing surface; `atEnd` also puts the caret after the last character (otherwise the selection is kept). */
  focus(atEnd = false): void {
    if (atEnd) this.view.dispatch(this.view.state.tr.setSelection(Selection.atEnd(this.view.state.doc)));
    this.view.focus();
  }

  /**
   * Focuses the surface to begin an edit: the caret goes to the clicked point (else the end), and
   * text typed to start the edit is inserted there.
   */
  begin(start: { at?: { x: number; y: number }; text?: string } | null): void {
    const { view } = this;
    let tr = view.state.tr.setSelection(Selection.atEnd(view.state.doc));
    if (start?.at) {
      let hit: { pos: number } | null = null;
      try {
        hit = view.posAtCoords({ left: start.at.x, top: start.at.y });
      } catch {
        // no layout (tests): keep the end
      }
      if (hit) tr = tr.setSelection(Selection.near(tr.doc.resolve(hit.pos)));
    }
    if (start?.text) tr = tr.insertText(start.text);
    view.dispatch(tr);
    view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }

  format(): RichFormat {
    const state = this.view.state;
    const { $from } = state.selection;
    const link = linkAt(state);
    const block = $from.parent.type === schema.nodes['heading'] ? (`h${$from.parent.attrs['level'] as number}` as RichFormat['block']) : 'paragraph';
    let list: RichFormat['list'] = null;
    for (let d = $from.depth; d > 0 && !list; d--) {
      const name = $from.node(d).type.name;
      if (name === 'bullet_list') list = 'bullet';
      else if (name === 'ordered_list') list = 'ordered';
    }
    return {
      bold: isMark(schema.marks['bold'])(state),
      italic: isMark(schema.marks['italic'])(state),
      underline: isMark(schema.marks['underline'])(state),
      code: isMark(schema.marks['code'])(state),
      link: link?.attrs['href'] ?? null,
      block,
      list,
      color: tokenAt(state, schema.marks['color']),
      size: tokenAt(state, schema.marks['size']),
    };
  }

  run(command: RichCommand): boolean {
    const { view } = this;
    const n = schema.nodes;
    const dispatch = view.dispatch.bind(view);
    const apply = (cmd: Command): boolean => cmd(view.state, dispatch, view);
    const list = (type: 'bullet_list' | 'ordered_list'): boolean => {
      const current = this.format().list;
      const target = type === 'bullet_list' ? 'bullet' : 'ordered';
      if (current === target) return apply(liftListItem(n['list_item']));
      if (current) apply(liftListItem(n['list_item']));
      return apply(wrapInList(n[type]));
    };
    switch (command) {
      case 'bold':
      case 'italic':
      case 'underline':
      case 'code':
        return apply(toggleMark(schema.marks[command]));
      case 'paragraph':
        return apply(setBlockType(n['paragraph']));
      case 'h1':
      case 'h2':
      case 'h3':
        return apply(setBlockType(n['heading'], { level: Number(command[1]) }));
      case 'bullet':
        return list('bullet_list');
      case 'ordered':
        return list('ordered_list');
      case 'indent':
        return apply(sinkListItem(n['list_item']));
      case 'outdent':
        return apply(liftListItem(n['list_item']));
      case 'undo':
        return apply(undo);
      case 'redo':
        return apply(redo);
    }
  }

  /** Links the selection to `href` (a web or mail address); `null` removes the link. Returns `false` for an unsafe address. */
  setLink(href: string | null): boolean {
    const type = schema.marks['link'];
    if (href !== null && !isSafeHref(href)) return false;
    const { state } = this.view;
    const range = linkRange(state) ?? { from: state.selection.from, to: state.selection.to };
    let tr = state.tr;
    if (href === null) {
      tr = tr.removeMark(range.from, range.to, type);
    } else if (range.from === range.to) {
      // Nothing selected: the address itself becomes the link text.
      tr = tr.insertText(href, range.from).addMark(range.from, range.from + href.length, type.create({ href }));
    } else {
      tr = tr.removeMark(range.from, range.to, type).addMark(range.from, range.to, type.create({ href }));
    }
    this.view.dispatch(tr);
    return true;
  }

  setColor(token: string | null): void {
    this.setTokenMark(schema.marks['color'], token);
  }

  setSize(token: string | null): void {
    this.setTokenMark(schema.marks['size'], token);
  }

  private setTokenMark(type: MarkType, token: string | null): void {
    const { state } = this.view;
    const { from, to, empty } = state.selection;
    if (empty) {
      const base = (state.storedMarks ?? state.selection.$from.marks()).filter((m) => m.type !== type);
      this.view.dispatch(state.tr.setStoredMarks(token ? [...base, type.create({ token })] : base));
      return;
    }
    const tr = state.tr.removeMark(from, to, type);
    this.view.dispatch(token ? tr.addMark(from, to, type.create({ token })) : tr);
  }
}

/** The selection, or with a bare caret inside a link the whole run of text carrying that link. */
function linkRange(state: EditorState): { from: number; to: number } | null {
  const type = schema.marks['link'];
  const { $from, empty, from, to } = state.selection;
  if (!empty) return state.doc.rangeHasMark(from, to, type) ? { from, to } : null;
  const start = $from.start();
  let run: { from: number; to: number; href: unknown } | null = null;
  let found: { from: number; to: number } | null = null;
  $from.parent.forEach((child, offset) => {
    const a = start + offset;
    const href = child.isText ? type.isInSet(child.marks)?.attrs['href'] : undefined;
    if (href === undefined) run = null;
    else if (run && run.href === href) run.to = a + child.nodeSize;
    else run = { from: a, to: a + child.nodeSize, href };
    if (run && $from.pos >= run.from && $from.pos <= run.to) found = { from: run.from, to: run.to };
  });
  return found;
}

function linkAt(state: EditorState) {
  const type = schema.marks['link'];
  const { $from, from, to, empty } = state.selection;
  if (empty) return type.isInSet(state.storedMarks ?? $from.marks()) ?? null;
  let found = null;
  state.doc.nodesBetween(from, to, (node) => {
    found ??= type.isInSet(node.marks) ?? null;
  });
  return found as ReturnType<typeof type.isInSet> | null;
}

function tokenAt(state: EditorState, type: MarkType): string | null {
  const { $from, from, to, empty } = state.selection;
  const mark = empty ? type.isInSet(state.storedMarks ?? $from.marks()) : (() => {
    let found: ReturnType<typeof type.isInSet> | null = null;
    state.doc.nodesBetween(from, to, (node) => {
      found ??= type.isInSet(node.marks) ?? null;
    });
    return found;
  })();
  return (mark?.attrs['token'] as string | undefined) ?? null;
}
