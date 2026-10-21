// Types shared by the editor chunk and the (eager) text-editing service; no ProseMirror here.

/** What the format controls show for the current selection. */
export interface RichFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  code: boolean;
  /** Address of the link under the selection. */
  link: string | null;
  block: 'paragraph' | 'h1' | 'h2' | 'h3';
  list: 'bullet' | 'ordered' | null;
  color: string | null;
  size: string | null;
}

export type RichCommand = 'bold' | 'italic' | 'underline' | 'code' | 'paragraph' | 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'indent' | 'outdent' | 'undo' | 'redo';
