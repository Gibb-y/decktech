import { parse } from 'acorn';
import { validateComponent, type ComponentDef } from '../src/app/core/model';
import { flagsOf } from '../src/app/components/trust/analysis';

export interface ComponentCheck {
  /** No error: the definition is valid and the script parses. Warnings do not make it invalid. */
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Always false: this check reads the source, nothing is run (code written by an agent is untrusted, ADR-008). */
  executed: false;
}

type Source = Pick<ComponentDef, 'html' | 'css' | 'js'>;

/** Syntax error of the script as the runtime would load it (an ES module, ADR-011), or `undefined`. */
export function scriptSyntaxError(js: string): string | undefined {
  try {
    parse(js, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
    return undefined;
  } catch (e) {
    const { loc } = e as { loc?: { line: number; column: number } };
    const message = e instanceof Error ? e.message.replace(/ \(\d+:\d+\)$/, '') : String(e);
    return loc ? `${message} (line ${loc.line}, column ${loc.column + 1})` : message;
  }
}

/** Hints about code that is likely not to do what its author expects inside the sandbox (8.2, 8.3). */
export function sandboxWarnings(def: Source & Pick<ComponentDef, 'permissions'>): string[] {
  const warnings: string[] = [];
  const { html, css, js, permissions } = def;
  if (js.trim() !== '' && !/\bdeck\s*\.\s*ready\s*\(/.test(js)) {
    warnings.push('The script never calls deck.ready(...); props, theme and size only arrive through it.');
  }
  if (/\bdeck\s*\.\s*fetch\b/.test(js) && !permissions.includes('network')) {
    warnings.push('The script uses deck.fetch but the component does not request the "network" permission, so deck.fetch does not exist.');
  }
  if (/<script\b/i.test(html)) warnings.push('Inline <script> in the HTML is blocked by the content security policy; put the code in the JS source.');
  if (/\bon[a-z]+\s*=\s*["']/i.test(html)) warnings.push('Inline event attributes (onclick="...") are blocked by the content security policy; attach handlers in the JS source.');
  if (/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(html) || /@import\b/i.test(css)) {
    warnings.push('External stylesheets cannot be loaded (no network); put the CSS in the CSS source.');
  }
  if (/\b(?:window\.)?(?:parent|top)\s*\./.test(js) || /\bdocument\s*\.\s*cookie\b/.test(js) || /\b(?:localStorage|sessionStorage|indexedDB)\b/.test(js)) {
    warnings.push('The sandbox has an opaque origin: parent/top access, cookies, localStorage and IndexedDB are unavailable. Use deck.state for small persisted state.');
  }
  return warnings;
}

/**
 * Checks a definition without running it: the structural rules of `validateComponent` (limits, prop
 * specs, permissions), the script's syntax, and heuristic hints, among them the flags the trust
 * dialog will show (ADR-008). `assetIds` are the assets of the deck the component would live in.
 */
export function checkComponentDef(def: ComponentDef, assetIds: Iterable<string>): ComponentCheck {
  const errors: string[] = [];
  const structure = validateComponent(def, assetIds);
  if (!structure.ok) errors.push(...structure.error.map((p) => `${p.path} ${p.message}`));
  const syntax = scriptSyntaxError(def.js);
  if (syntax) errors.push(`The script has a syntax error: ${syntax}`);
  const warnings = [...sandboxWarnings(def), ...flagsOf(def).map((f) => `Trust dialog will flag: ${f.text}`)];
  return { valid: errors.length === 0, errors, warnings, executed: false };
}
