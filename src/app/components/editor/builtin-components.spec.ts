import { createDeck, validateComponent, validateDeck, type ComponentDef } from '../../core/model';
import type { JsonValue } from '../host/protocol';
import { AddCodeElement } from '../../core/store';
import { resolveProps } from '../host/props';
import { runComponent, tick } from '../host/frame-harness';
import { BUILT_IN_COMPONENTS, CHART_COMPONENT, EMBED_COMPONENT, LIVE_DEMO_COMPONENT, POLL_COMPONENT, QUIZ_COMPONENT } from './builtin-components';
import { networkDependencies } from './vendor';

const NAMES = ['Counter', 'Bar chart', 'Live code demo', 'Quiz', 'Poll', 'Web page link'];

describe('built-in components', () => {
  it('are the examples of the issue, with unique ids and names', () => {
    expect(BUILT_IN_COMPONENTS.map((c) => c.name)).toEqual(NAMES);
    expect(new Set(BUILT_IN_COMPONENTS.map((c) => c.id)).size).toBe(BUILT_IN_COMPONENTS.length);
  });

  it.each(BUILT_IN_COMPONENTS.map((c) => [c.name, c] as const))('%s is a valid definition that inserts into a deck and loads again', (_name, def) => {
    expect(validateComponent(def, []).ok).toBe(true);
    const deck = createDeck();
    const insert = new AddCodeElement(deck.slides[0].id, def).do(deck).deck;
    expect(validateDeck(JSON.parse(JSON.stringify(insert))).ok).toBe(true);
    expect(def.html + def.css + def.js).not.toMatch(/<\/script/i);
  });

  it.each(BUILT_IN_COMPONENTS.map((c) => [c.name, c] as const))('%s works offline: it names no network address', (_name, def) => {
    expect(networkDependencies(def)).toEqual([]);
    expect(def.permissions).toEqual([]);
  });

  it.each(BUILT_IN_COMPONENTS.map((c) => [c.name, c] as const))('%s runs in the real runtime with its default props, without errors', async (_name, def) => {
    const errors: string[] = [];
    const frame = await runComponent(def, { props: resolveProps(def, {}), state: {}, saved: [], errors });
    expect(errors).toEqual([]);
    expect(frame.document.body.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });
});

describe('the examples behave', () => {
  const run = (def: ComponentDef, props: Record<string, unknown>, state: Record<string, JsonValue> = {}, saved: Record<string, JsonValue>[] = []) =>
    runComponent(def, { props: resolveProps(def, props), state, saved });

  it('chart draws one bar per valid row, ignores bad rows, and describes itself', async () => {
    const { document, bridge } = await run(CHART_COMPONENT, { data: 'A:1, B:3, bad, C:x, D:-2, E:2', title: 'T' });
    expect(document.querySelectorAll('#plot rect')).toHaveLength(3);
    expect(document.getElementById('caption')?.textContent).toBe('T');
    expect(document.getElementById('plot')?.getAttribute('aria-label')).toBe('A 1, B 3, E 2');
    bridge.send({ type: 'props', props: resolveProps(CHART_COMPONENT, { data: 'Q:5' }) });
    await tick();
    expect(document.querySelectorAll('#plot rect')).toHaveLength(1);
  });

  it('chart treats markup in labels as text', async () => {
    const { document } = await run(CHART_COMPONENT, { data: '<img src=x onerror=alert(1)>:4' });
    expect(document.querySelector('#plot img')).toBeNull();
    expect(document.querySelector('#plot text')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('chart caps the number of bars', async () => {
    const data = Array.from({ length: 40 }, (_, i) => `r${i}:${i}`).join(',');
    expect((await run(CHART_COMPONENT, { data })).document.querySelectorAll('#plot rect')).toHaveLength(24);
  });

  it('quiz marks the choice, says whether it is right and keeps the choice in deck.state', async () => {
    const saved: Record<string, JsonValue>[] = [];
    const { document } = await run(QUIZ_COMPONENT, { options: 'one\ntwo\nthree', answer: 2 }, {}, saved);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#options button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['one', 'two', 'three']);
    buttons[0].click();
    expect(document.getElementById('result')?.textContent).toBe('Not quite.');
    buttons[1].click();
    expect(document.getElementById('result')?.textContent).toBe('Correct!');
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    await tick();
    expect(saved.at(-1)).toEqual({ choice: 1 });
    const again = await run(QUIZ_COMPONENT, { options: 'one\ntwo\nthree', answer: 2 }, saved.at(-1));
    expect(again.document.getElementById('result')?.textContent).toBe('Correct!');
  });

  it('poll counts votes, shows shares and survives a reload through deck.state', async () => {
    const saved: Record<string, JsonValue>[] = [];
    const { document } = await run(POLL_COMPONENT, { options: 'a\nb' }, {}, saved);
    const click = (i: number) => document.querySelectorAll<HTMLButtonElement>('#rows button')[i].click();
    click(0);
    click(0);
    click(1);
    expect([...document.querySelectorAll('#rows output')].map((o) => o.textContent)).toEqual(['2', '1']);
    await tick();
    expect(saved.at(-1)).toEqual({ votes: [2, 1] });
    const again = await run(POLL_COMPONENT, { options: 'a\nb' }, saved.at(-1));
    expect([...again.document.querySelectorAll('#rows output')].map((o) => o.textContent)).toEqual(['2', '1']);
  });

  it('poll ignores a stored tally that is not numbers', async () => {
    const { document } = await run(POLL_COMPONENT, { options: 'a\nb' }, { votes: ['x', null] as unknown as JsonValue });
    expect([...document.querySelectorAll('#rows output')].map((o) => o.textContent)).toEqual(['0', '0']);
  });

  it('live demo applies the css to the box, without letting braces end the rule', async () => {
    const { document } = await run(LIVE_DEMO_COMPONENT, { css: 'color: red;' });
    const source = document.getElementById('src') as HTMLTextAreaElement;
    source.value = 'color: blue; } body { display: none';
    source.dispatchEvent(new document.defaultView!.Event('input'));
    expect(document.head.querySelectorAll('style').length).toBeGreaterThan(0);
    const rule = [...document.head.querySelectorAll('style')].at(-1)!.textContent;
    expect(rule).toBe('#box { color: blue;  body  display: none }');
  });

  it('web page link shows the host and offers the address as a link the runtime hands to the host', async () => {
    const { document } = await run(EMBED_COMPONENT, { url: 'https://example.org/path?q=1', title: 'Demo' });
    expect(document.getElementById('host')?.textContent).toBe('example.org');
    expect(document.getElementById('title')?.textContent).toBe('Demo');
    expect((document.getElementById('card') as HTMLAnchorElement).href).toBe('https://example.org/path?q=1');
  });

  it('web page link shows an address that is not a URL as typed', async () => {
    const { document } = await run(EMBED_COMPONENT, { url: 'not a url' });
    expect(document.getElementById('host')?.textContent).toBe('not a url');
  });
});
