import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PAIRS, contrast, countLiterals, findContrastFailures, findCssProblems, findLiteralViolations, isChromeFile, tokenSets } from './check-tokens.mjs';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css'), 'utf8');

describe('styles.css', () => {
  it('has no problems', () => assert.deepEqual(findCssProblems(css), []));

  it('defines the dark set twice, identically, and only over light tokens', () => {
    const { light, darkMedia, darkAttribute } = tokenSets(css);
    assert.ok(Object.keys(darkAttribute).length > 20);
    assert.deepEqual(darkMedia, darkAttribute);
    for (const name of Object.keys(darkAttribute)) assert.ok(Object.hasOwn(light, name), name);
  });

  it('checks every pair in both modes', () => {
    const { light, dark } = tokenSets(css);
    for (const tokens of [light, dark]) for (const [fg, bg] of PAIRS) assert.ok(tokens[fg] && tokens[bg], `${fg} / ${bg}`);
  });

  it('notices a dark copy that drifts', () => {
    const drifted = css.replace(/(:root\[data-theme='dark'\] \{[^}]*--text: )#e8eaee/, '$1#e8eaef');
    assert.notEqual(drifted, css);
    assert.match(findCssProblems(drifted).join('\n'), /dark copies differ for --text/);
  });

  it('notices a pair below AA', () => {
    const weak = css.replace(/(:root \{[^}]*--text-muted: )#4a5262/, '$1#9aa1ae');
    assert.match(findCssProblems(weak).join('\n'), /light: --text-muted on --surface/);
  });

  it('notices a missing token', () => {
    assert.deepEqual(findContrastFailures({}, [['--text', '--surface', 4.5]]), ['--text is not defined']);
  });
});

describe('contrast', () => {
  it('matches the WCAG reference values', () => {
    assert.equal(contrast('#000000', '#ffffff').toFixed(2), '21.00');
    assert.equal(contrast('#ffffff', '#ffffff'), 1);
    assert.equal(contrast('#767676', '#ffffff').toFixed(2), '4.54');
  });
});

describe('colour literals', () => {
  it('only chrome code is checked', () => {
    assert.equal(isChromeFile('app/editor/editor-shell.ts'), true);
    assert.equal(isChromeFile('app/library/library-page.css'), true);
    for (const p of ['styles.css', 'app/core/model/themes.ts', 'app/renderer/theme.ts', 'app/editor/editor-shell.spec.ts', 'app/components/host/sandbox.ts', 'favicon.ico']) {
      assert.equal(isChromeFile(p), false, p);
    }
  });

  it('counts hex, rgb and hsl literals but not ids, anchors or tokens', () => {
    const text = [
      'a { color: #0b3d91; border: 1px solid #c3c6cc; background: #FFF; }',
      'b { color: rgb(1 2 3); fill: hsla(10, 20%, 30%, 0.5); box-shadow: 0 0 #abcd12ef; }',
      'c { color: var(--text); } <a href="#main-content"> <a href="#"> #abcde #12345g',
    ].join('\n');
    assert.deepEqual(countLiterals([{ path: 'app/editor/x.css', text }]), { 'app/editor/x.css': 6 });
  });

  it('fails a file that gains literals or is new, and notes one that lost some', () => {
    const counts = { 'app/a.ts': 3, 'app/b.ts': 1 };
    const { problems, notes } = findLiteralViolations(counts, { 'app/a.ts': 2, 'app/c.ts': 4, constructor: 9 });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /app\/a\.ts: 3 colour literal\(s\), 2 allowed/);
    assert.match(problems[1], /app\/b\.ts: 1 colour literal\(s\), 0 allowed/);
    assert.equal(notes.length, 2);
  });

  it('holds for the repository against its baseline', () => {
    // The CLI run in `npm run lint:tokens` is the real gate; this keeps the unit tests honest about the baseline file format.
    const baseline = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'token-baseline.json'), 'utf8'));
    assert.ok(Object.values(baseline).every((n) => Number.isInteger(n) && n > 0));
  });
});
