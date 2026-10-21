import { createDeck, createSlide, validateDeck, createElement, type CodeEl } from '../../core/model';
import { COUNTER_COMPONENT } from './examples';
import { runComponent, tick } from './frame-harness';
import type { JsonValue } from './protocol';
import { resolveProps } from './props';

/** The counter example, end to end, in the real document with the real runtime (`runComponent`). */
async function runCounter(options: { props: Record<string, unknown>; state: Record<string, JsonValue>; saved: Record<string, JsonValue>[] }) {
  const frame = await runComponent(COUNTER_COMPONENT, options);
  const button = frame.document.getElementById('inc') as HTMLButtonElement;
  const output = frame.document.getElementById('n') as HTMLElement;
  return { ...frame, button, output };
}

describe('counter example', () => {
  it('is a valid component that can be inserted into a deck', () => {
    const deck = createDeck();
    const slide = createSlide(deck.layouts[0].id);
    const element = createElement('code', { componentId: COUNTER_COMPONENT.id, props: { start: 2, label: 'Go' } });
    const result = validateDeck({ ...deck, components: [COUNTER_COMPONENT], slides: [{ ...slide, elements: [element] }] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(COUNTER_COMPONENT.html + COUNTER_COMPONENT.css + COUNTER_COMPONENT.js).not.toMatch(/<\/script/i);
  });

  it('renders with its props and keeps its count in deck.state', async () => {
    const saved: Record<string, JsonValue>[] = [];
    const props = resolveProps(COUNTER_COMPONENT, { start: 5, label: 'Plus' } satisfies Partial<CodeEl['props']>);
    const frame = await runCounter({ props, state: {}, saved });
    expect(frame.button.textContent).toBe('Plus');
    expect(frame.output.textContent).toBe('5');
    frame.button.click();
    frame.button.click();
    await tick();
    expect(frame.output.textContent).toBe('7');
    expect(saved.at(-1)).toEqual({ n: 7 });
  });

  it('continues from the persisted state when the frame is built again', async () => {
    const saved: Record<string, JsonValue>[] = [];
    const first = await runCounter({ props: resolveProps(COUNTER_COMPONENT, {}), state: {}, saved });
    first.button.click();
    first.button.click();
    first.button.click();
    await tick();
    const second = await runCounter({ props: resolveProps(COUNTER_COMPONENT, {}), state: saved.at(-1)!, saved: [] });
    expect(second.output.textContent).toBe('3');
    second.button.click();
    expect(second.output.textContent).toBe('4');
  });

  it('follows prop changes from the properties panel', async () => {
    const frame = await runCounter({ props: resolveProps(COUNTER_COMPONENT, {}), state: {}, saved: [] });
    expect(frame.button.textContent).toBe('Add one');
    frame.bridge.send({ type: 'props', props: resolveProps(COUNTER_COMPONENT, { label: 'Renamed' }) });
    await tick();
    expect(frame.button.textContent).toBe('Renamed');
  });

  it('carries the theme into the frame as CSS variables', async () => {
    const frame = await runCounter({ props: {}, state: {}, saved: [] });
    const base = frame.window.document.getElementById('deck-base')!.textContent!;
    expect(base).toContain('--deck-color-text');
    expect(frame.window.document.documentElement.style.getPropertyValue('--deck-color-text')).not.toBe('');
  });
});
