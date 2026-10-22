export type FormatLanguage = 'html' | 'css' | 'js' | 'text';

/** Longest text the viewer formats; a bigger one is shown as it is (the pass is linear, but the copy would be huge). */
export const MAX_FORMAT_LENGTH = 2 * 1024 * 1024;

/**
 * A pretty-printed copy of `source` for reading, never used for anything else. JavaScript and CSS
 * get a line break after `{`, `}` and `;` outside strings, comments and parentheses, with the
 * indent following the braces; HTML gets a break between tags. It is a heuristic, not a parser: a
 * regular expression literal that holds a quote or a brace can throw it off, which only makes the
 * copy look odd. The original text is always one click away.
 */
export function formatForViewing(source: string, language: FormatLanguage): string {
  if (source.length > MAX_FORMAT_LENGTH) return source;
  if (language === 'html') return source.replace(/>\s*</g, '>\n<');
  if (language === 'css' || language === 'js') return formatBraces(source, language === 'js');
  return source;
}

function formatBraces(source: string, script: boolean): string {
  let out = '';
  let depth = 0;
  let parens = 0;
  let lineStart = true;
  const indent = () => '  '.repeat(Math.max(0, depth));
  const put = (text: string) => {
    if (lineStart) {
      out += indent();
      lineStart = false;
    }
    out += text;
  };
  const newline = () => {
    out = out.replace(/[ \t]+$/, '');
    out += '\n';
    lineStart = true;
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '"' || c === "'" || (script && c === '`')) {
      let end = i + 1;
      while (end < source.length && source[end] !== c) end += source[end] === '\\' ? 2 : 1;
      put(source.slice(i, end + 1));
      i = end;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      put(source.slice(i, stop));
      i = stop - 1;
    } else if (script && c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      put(source.slice(i, stop));
      i = stop - 1;
      newline();
    } else if (c === '(') {
      parens++;
      put(c);
    } else if (c === ')') {
      parens = Math.max(0, parens - 1);
      put(c);
    } else if (c === '{') {
      put(c);
      depth++;
      newline();
    } else if (c === '}') {
      depth = Math.max(0, depth - 1);
      if (!lineStart) newline();
      put(c);
      // `} else`, `}) ` and `};` stay on the closing line.
      if (!/^\s*(?:else\b|catch\b|finally\b|[);,.\]])/.test(source.slice(i + 1, i + 12))) newline();
    } else if (c === ';' && parens === 0) {
      put(c);
      newline();
    } else if (c === '\n' || c === '\r') {
      if (!lineStart) newline();
    } else if ((c === ' ' || c === '\t') && lineStart) {
      continue;
    } else {
      put(c);
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
