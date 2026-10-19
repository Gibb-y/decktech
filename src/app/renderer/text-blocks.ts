export type TextBlock = { kind: 'paragraph'; text: string } | { kind: 'list'; items: string[] };

const BULLET = /^\s*[-*•]\s+(.*)$/;

/**
 * Splits plain element text into paragraphs and bullet lists for semantic output (arc42 §8.8).
 * Each non-empty line is a paragraph; consecutive lines starting with `-`, `*` or `•` form a list.
 * Replaced when ProseMirror JSON (ADR-004) becomes the text format.
 */
export function parseText(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() === '') continue;
    const bullet = BULLET.exec(line);
    const last = blocks[blocks.length - 1];
    if (bullet) {
      if (last?.kind === 'list') last.items.push(bullet[1]);
      else blocks.push({ kind: 'list', items: [bullet[1]] });
    } else {
      blocks.push({ kind: 'paragraph', text: line.trim() });
    }
  }
  return blocks;
}
