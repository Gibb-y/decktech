import type { ComponentDef } from '../../core/model';
import { normalizeOrigin } from './protocol';

export interface DocumentInput {
  def: Pick<ComponentDef, 'html' | 'css' | 'js'>;
  /** Source of `deck-runtime.js`; inlined, because the frame's CSP allows no external script. */
  runtime: string;
  /** `--deck-*` custom properties of the theme (`themeVars`). */
  themeVars: Record<string, string>;
  /** Origins the `network` permission was granted for; empty when there is none. */
  networkOrigins?: readonly string[];
}

const SAFE_VAR_NAME = /^--deck-[a-z]+-[A-Za-z0-9_-]{1,64}$/;
const SAFE_VAR_VALUE = /^[^;{}<>\\]*$/;

/**
 * The Content-Security-Policy of every frame (arc42 §8.2). Scripts may be inline, `eval` and
 * blob (the runtime turns the user's module and the vendored libraries into blob URLs); styles may
 * be inline; images, fonts and media only from blob/data; nothing may connect anywhere unless the
 * `network` permission was granted, and then only to the listed origins.
 */
export function contentSecurityPolicy(networkOrigins: readonly string[] = []): string {
  const origins = [...new Set(networkOrigins.flatMap((origin) => normalizeOrigin(origin) ?? []))];
  const extra = origins.length > 0 ? ` ${origins.join(' ')}` : '';
  return [
    `default-src 'none'`,
    `script-src 'unsafe-inline' 'unsafe-eval' blob:`,
    `style-src 'unsafe-inline'`,
    `img-src blob: data:${extra}`,
    `font-src blob: data:`,
    `media-src blob:`,
    `connect-src ${origins.length > 0 ? origins.join(' ') : `'none'`}`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');
}

/** Text that stays inside a `<style>` element however it is written. */
const styleText = (css: string): string => css.replace(/<\/style/gi, '<\\/style');

/** A JSON string literal that cannot end its `<script>` element (`<` becomes `<`). */
const jsonText = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * Assembles the `srcdoc` of a code component (arc42 §5.3): the CSP first, the theme variables,
 * the user's CSS, the runtime, then the user's HTML. The user's JavaScript is carried as inert
 * JSON and run by the runtime as a module once the host has answered the handshake, after the
 * import map for the vendored libraries exists (the libraries only get their blob URLs then).
 */
export function buildDocument(input: DocumentInput): string {
  if (/<\/script/i.test(input.runtime)) throw new Error('The runtime must not contain a closing script tag');
  const vars = Object.entries(input.themeVars)
    .filter(([name, value]) => SAFE_VAR_NAME.test(name) && SAFE_VAR_VALUE.test(value))
    .map(([name, value]) => `${name}:${value};`)
    .join('');
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(input.networkOrigins)}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="deck-base">:root{${vars}}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:var(--deck-color-text,#111);font-family:var(--deck-font-body,sans-serif)}</style>`,
    `<style id="deck-user-css">${styleText(input.def.css)}</style>`,
    `<script id="deck-runtime">${input.runtime}</script>`,
    '</head><body>',
    input.def.html,
    `<script type="application/json" id="deck-user-js">${jsonText(input.def.js)}</script>`,
    '</body></html>',
  ].join('');
}
