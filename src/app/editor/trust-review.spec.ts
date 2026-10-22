import { Component, input, output, signal } from '@angular/core';
import { createElement, type ComponentDef, type Deck } from '../core/model';
import { CODE_TRUST, COMPONENT_TOOLS, type CodeTrust } from '../renderer';
import { openEditor, settle, type Editor } from './editor-test-setup';

afterEach(() => document.body.replaceChildren());

const COMPONENT: ComponentDef = { id: 'cp_x', name: 'X', html: '', css: '', js: '', propSchema: [], permissions: [], files: [], libs: [] };

const prepare = (deck: Deck) => {
  deck.components.push(COMPONENT);
  deck.slides[0].elements.push(createElement('code', { componentId: COMPONENT.id, x: 100, y: 100, w: 600, h: 300 }));
};

@Component({ selector: 'app-fake-tools', template: `<div role="dialog" class="fake">{{ view() }} <button type="button" (click)="closed.emit()">Close fake</button></div>` })
class FakeTools {
  readonly view = input<'edit' | 'library' | 'trust'>('edit');
  readonly elementId = input<string | null>(null);
  readonly closed = output<void>();
}

/** Stands in for `TrustStore` (the editor may not import the components feature). */
class FakeTrust implements CodeTrust {
  readonly pending = signal(true);
  readonly fromFile = signal(true);
  refresh = vi.fn<(deckId: string) => Promise<void>>(async () => undefined);
  governs(): boolean {
    return this.fromFile();
  }
  needsReview(): boolean {
    return this.pending();
  }
}

async function open(trust: FakeTrust | null, options: { tools?: boolean; withCode?: boolean } = {}) {
  return openEditor({
    prepare: options.withCode === false ? undefined : prepare,
    providers: [...(options.tools === false ? [] : [{ provide: COMPONENT_TOOLS, useValue: () => Promise.resolve(FakeTools) }]), ...(trust ? [{ provide: CODE_TRUST, useValue: trust }] : [])],
  });
}

const dialog = () => document.querySelector('app-fake-tools .fake');
const closeDialog = async (e: Editor) => {
  document.querySelector<HTMLButtonElement>('app-fake-tools button')!.click();
  await settle(e.fixture);
};
const reviewButton = (e: Editor) => Array.from(e.root.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Review code…');

describe('reviewing the code of a deck when it is opened', () => {
  it('reads the trust decision of the deck before showing it', async () => {
    const trust = new FakeTrust();
    const e = await open(trust);
    expect(trust.refresh).toHaveBeenCalledWith(e.deck.id);
    expect(e.root.querySelector('app-canvas')).not.toBeNull();
  });

  it('does not show the deck until the decision has been read', async () => {
    const trust = new FakeTrust();
    let release: () => void = () => undefined;
    trust.refresh = vi.fn<(deckId: string) => Promise<void>>(() => new Promise<void>((resolve) => (release = resolve)));
    const e = await open(trust);
    expect(e.root.querySelector('app-canvas')).toBeNull();
    expect(e.root.textContent).toContain('Opening deck');
    release();
    await settle(e.fixture);
    expect(e.root.querySelector('app-canvas')).not.toBeNull();
  });

  it('asks about code nobody has decided on, once, and does not come back after it is closed', async () => {
    const e = await open(new FakeTrust());
    expect(dialog()?.textContent).toContain('trust');
    await closeDialog(e);
    expect(dialog()).toBeNull();
    await settle(e.fixture);
    expect(dialog()).toBeNull();
  });

  it('does not ask when everything is decided, and keeps the button', async () => {
    const decided = new FakeTrust();
    decided.pending.set(false);
    const e = await open(decided);
    expect(dialog()).toBeNull();
    expect(reviewButton(e)).toBeDefined();
  });

  it('has no button for a deck made here: it has no decisions to review', async () => {
    const trust = new FakeTrust();
    trust.pending.set(false);
    trust.fromFile.set(false);
    const e = await open(trust);
    expect(reviewButton(e)).toBeUndefined();
  });

  it('has no button for a deck without code components', async () => {
    const e = await open(new FakeTrust(), { withCode: false });
    expect(reviewButton(e)).toBeUndefined();
  });

  it('asks once per opened deck: code that turns undecided later is reached with the button', async () => {
    const trust = new FakeTrust();
    const e = await open(trust);
    await closeDialog(e);
    trust.pending.set(false);
    await settle(e.fixture);
    trust.pending.set(true);
    await settle(e.fixture);
    expect(dialog()).toBeNull();
    reviewButton(e)!.click();
    await settle(e.fixture);
    expect(dialog()?.textContent).toContain('trust');
  });

  it('"Review code…" opens the trust dialog at any time', async () => {
    const trust = new FakeTrust();
    trust.pending.set(false);
    const e = await open(trust);
    reviewButton(e)!.click();
    await settle(e.fixture);
    expect(dialog()?.textContent).toContain('trust');
    await closeDialog(e);
    expect(dialog()).toBeNull();
  });

  it('works without the trust provider, and asks for nothing', async () => {
    const e = await open(null);
    expect(dialog()).toBeNull();
    expect(e.root.querySelector('app-canvas')).not.toBeNull();
  });

  it('works without the tools: nothing to show and no button', async () => {
    const e = await open(new FakeTrust(), { tools: false });
    expect(dialog()).toBeNull();
    expect(reviewButton(e)).toBeUndefined();
    expect(e.root.querySelector('app-canvas')).not.toBeNull();
  });
});
