import { currentSlideButton, openEditor, press, runAxe, settle, slideButtons, type as typeInto } from '../editor-test-setup';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function dragEvent(type: string, target: Element, clientY = 0): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientY', { value: clientY });
  Object.defineProperty(event, 'dataTransfer', { value: { setData: vi.fn(), effectAllowed: '', dropEffect: '' } });
  target.dispatchEvent(event);
  return event;
}

describe('SlideSorter', () => {
  it('lists the slides with names that include their first text, and one tab stop', async () => {
    const { root, store } = await openEditor();
    const buttons = slideButtons(root);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Slide 1: Welcome', 'Slide 2', 'Slide 3']);
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    expect(currentSlideButton(root)).toBe(buttons[0]);
    expect(store.currentSlideId()).toBe(store.slides()[0].id);
  });

  it('moves between slides with the arrow keys, Home and End, keeping focus on the current one', async () => {
    const { fixture, root, store } = await openEditor();
    press(slideButtons(root)[0], 'ArrowDown');
    await settle(fixture);
    expect(store.currentSlideIndex()).toBe(1);
    expect(document.activeElement).toBe(slideButtons(root)[1]);
    expect(slideButtons(root).map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
    press(document.activeElement!, 'End');
    await settle(fixture);
    expect(store.currentSlideIndex()).toBe(2);
    press(document.activeElement!, 'ArrowDown'); // stays at the end
    await settle(fixture);
    expect(store.currentSlideIndex()).toBe(2);
    press(document.activeElement!, 'Home');
    await settle(fixture);
    expect(store.currentSlideIndex()).toBe(0);
    press(document.activeElement!, 'ArrowUp'); // stays at the start
    await settle(fixture);
    expect(store.currentSlideIndex()).toBe(0);
    expect(document.activeElement).toBe(slideButtons(root)[0]);
  });

  it('Enter adds a slide after the current one, selects it and keeps the focus on it', async () => {
    const { fixture, root, store } = await openEditor();
    const before = store.slides().map((s) => s.id);
    const event = press(slideButtons(root)[0], 'Enter');
    await settle(fixture);
    expect(event.defaultPrevented).toBe(true);
    expect(store.slides()).toHaveLength(4);
    expect(store.slides().map((s) => s.id).filter((id) => !before.includes(id))).toEqual([store.currentSlideId()]);
    expect(store.currentSlideIndex()).toBe(1);
    expect(document.activeElement).toBe(slideButtons(root)[1]);
    store.undo();
    expect(store.slides().map((s) => s.id)).toEqual(before);
  });

  it('Alt+Arrow moves the slide as one undo step and keeps the focus on it', async () => {
    const { fixture, root, store } = await openEditor();
    const [a, b, c] = store.slides().map((s) => s.id);
    press(slideButtons(root)[0], 'ArrowDown', { altKey: true });
    await settle(fixture);
    expect(store.slides().map((s) => s.id)).toEqual([b, a, c]);
    expect(store.currentSlideId()).toBe(a);
    expect(document.activeElement).toBe(slideButtons(root)[1]);
    press(document.activeElement!, 'ArrowUp', { altKey: true });
    await settle(fixture);
    expect(store.slides().map((s) => s.id)).toEqual([a, b, c]);
    store.undo();
    expect(store.slides().map((s) => s.id)).toEqual([b, a, c]);
  });

  it('Alt+Arrow at either end changes nothing and says so', async () => {
    const { fixture, root, store, announcer } = await openEditor();
    const announce = vi.spyOn(announcer, 'announce');
    press(slideButtons(root)[0], 'ArrowUp', { altKey: true });
    await settle(fixture);
    expect(announce).toHaveBeenLastCalledWith('Already the first slide');
    expect(store.canUndo()).toBe(false);
    press(slideButtons(root)[0], 'End');
    await settle(fixture);
    press(document.activeElement!, 'ArrowDown', { altKey: true });
    expect(announce).toHaveBeenLastCalledWith('Already the last slide');
    expect(store.canUndo()).toBe(false);
  });

  it('Delete removes the slide, selects its neighbour and refuses to remove the last one', async () => {
    const { fixture, root, store, announcer } = await openEditor({ slides: 2 });
    const announce = vi.spyOn(announcer, 'announce');
    const [first, second] = store.slides().map((s) => s.id);
    press(slideButtons(root)[0], 'Delete');
    await settle(fixture);
    expect(store.slides().map((s) => s.id)).toEqual([second]);
    expect(store.currentSlideId()).toBe(second);
    expect(document.activeElement).toBe(slideButtons(root)[0]);
    const deleteButton = root.querySelector<HTMLButtonElement>('.tools .danger')!;
    expect(deleteButton.getAttribute('aria-disabled')).toBe('true');
    press(slideButtons(root)[0], 'Delete');
    expect(announce).toHaveBeenLastCalledWith('A deck needs at least one slide');
    expect(store.slides()).toHaveLength(1);
    store.undo();
    expect(store.slides().map((s) => s.id)).toEqual([first, second]);
  });

  it('Ctrl+D duplicates the slide with fresh ids and selects the copy', async () => {
    const { fixture, root, store } = await openEditor();
    const original = store.slides()[0];
    press(slideButtons(root)[0], 'd', { ctrlKey: true });
    await settle(fixture);
    expect(store.slides()).toHaveLength(4);
    const copy = store.slides()[1];
    expect(copy.id).not.toBe(original.id);
    expect(copy.elements[0].id).not.toBe(original.elements[0].id);
    expect(store.currentSlideId()).toBe(copy.id);
    expect(document.activeElement).toBe(slideButtons(root)[1]);
  });

  it('the buttons do the same: add, duplicate, delete', async () => {
    const { root, store } = await openEditor();
    const [add, duplicate, , , remove] = Array.from(root.querySelectorAll<HTMLButtonElement>('.tools button'));
    add.click();
    expect(store.slides()).toHaveLength(4);
    duplicate.click();
    expect(store.slides()).toHaveLength(5);
    remove.click();
    expect(store.slides()).toHaveLength(4);
  });

  it('Move up and Move down reorder without dragging, and are unavailable at the ends', async () => {
    const { fixture, root, store } = await openEditor();
    const [a, b, c] = store.slides().map((s) => s.id);
    const up = Array.from(root.querySelectorAll<HTMLButtonElement>('.tools button')).find((x) => x.textContent === 'Move up')!;
    const down = Array.from(root.querySelectorAll<HTMLButtonElement>('.tools button')).find((x) => x.textContent === 'Move down')!;
    expect(up.getAttribute('aria-disabled')).toBe('true');
    expect(down.getAttribute('aria-disabled')).toBeNull();
    down.focus();
    down.click();
    await settle(fixture);
    expect(store.slides().map((s) => s.id)).toEqual([b, a, c]);
    expect(up.getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(down); // keyboard users can press it again
    down.click();
    await settle(fixture);
    expect(down.getAttribute('aria-disabled')).toBe('true');
    down.click(); // at the end: nothing happens
    expect(store.slides().map((s) => s.id)).toEqual([b, c, a]);
    up.click();
    expect(store.slides().map((s) => s.id)).toEqual([b, a, c]);
  });

  it('ignores slide shortcuts typed anywhere but on a slide button', async () => {
    const { root, store } = await openEditor();
    const add = root.querySelector<HTMLButtonElement>('.tools button')!;
    press(add, 'Delete');
    press(add, 'ArrowDown');
    expect(store.slides()).toHaveLength(3);
    expect(store.currentSlideIndex()).toBe(0);
  });

  describe('sections', () => {
    it('starts a section at the current slide and shows its heading', async () => {
      const { fixture, root, store } = await openEditor();
      const open = root.querySelector<HTMLButtonElement>('.tools button[aria-haspopup]')!;
      open.click();
      await settle(fixture);
      const input = root.querySelector<HTMLInputElement>('#section-name')!;
      expect(root.querySelector('label[for="section-name"]')?.textContent).toContain('Section');
      typeInto(input, '  Introduction ');
      root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle(fixture);
      expect(store.slides()[0].section).toBe('Introduction');
      expect(root.querySelector('.sorter .section')?.textContent).toBe('Introduction');
      expect(slideButtons(root)[0].getAttribute('aria-label')).toBe('Slide 1, starts section “Introduction”: Welcome');
      expect(root.querySelector('form')).toBeNull();
      expect(document.activeElement).toBe(open);
    });

    it('removes a section with an empty name and cancels with Escape', async () => {
      const { fixture, root, store } = await openEditor();
      const open = root.querySelector<HTMLButtonElement>('.tools button[aria-haspopup]')!;
      open.click();
      await settle(fixture);
      typeInto(root.querySelector<HTMLInputElement>('#section-name')!, 'Intro');
      root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle(fixture);
      open.click();
      await settle(fixture);
      const input = root.querySelector<HTMLInputElement>('#section-name')!;
      expect(input.value).toBe('Intro'); // prefilled
      press(input, 'Escape');
      await settle(fixture);
      expect(root.querySelector('form')).toBeNull();
      expect(store.slides()[0].section).toBe('Intro');
      open.click();
      await settle(fixture);
      typeInto(root.querySelector<HTMLInputElement>('#section-name')!, '');
      root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle(fixture);
      expect('section' in store.slides()[0]).toBe(false);
      expect(root.querySelector('.sorter .section')).toBeNull();
    });

    it('does not treat Enter or Delete in the section field as slide shortcuts', async () => {
      const { fixture, root, store } = await openEditor();
      root.querySelector<HTMLButtonElement>('.tools button[aria-haspopup]')!.click();
      await settle(fixture);
      const input = root.querySelector<HTMLInputElement>('#section-name')!;
      press(input, 'Enter');
      press(input, 'Delete');
      expect(store.slides()).toHaveLength(3);
    });
  });

  describe('drag and drop', () => {
    const items = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('.sorter li'));
    function prepare(root: HTMLElement) {
      for (const li of items(root)) li.getBoundingClientRect = () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) });
    }

    it('drops a slide where the indicator shows', async () => {
      const { fixture, root, store } = await openEditor();
      prepare(root);
      const [a, b, c] = store.slides().map((s) => s.id);
      dragEvent('dragstart', items(root)[0]);
      dragEvent('dragover', items(root)[2], 80); // lower half of the third slide: after it
      await settle(fixture);
      expect(items(root)[2].classList).toContain('drop-after');
      expect(items(root)[0].classList).toContain('dragging');
      dragEvent('drop', items(root)[2]);
      await settle(fixture);
      expect(store.slides().map((s) => s.id)).toEqual([b, c, a]);
      expect(root.querySelector('.drop-after, .drop-before, .dragging')).toBeNull();
    });

    it('drops before a slide when the pointer is in its upper half', async () => {
      const { fixture, root, store } = await openEditor();
      prepare(root);
      const [a, b, c] = store.slides().map((s) => s.id);
      dragEvent('dragstart', items(root)[2]);
      dragEvent('dragover', items(root)[0], 10);
      await settle(fixture);
      expect(items(root)[0].classList).toContain('drop-before');
      dragEvent('drop', items(root)[0]);
      expect(store.slides().map((s) => s.id)).toEqual([c, a, b]);
    });

    it('a drop where the slide already is changes nothing and records no history', async () => {
      const { root, store } = await openEditor();
      prepare(root);
      dragEvent('dragstart', items(root)[1]);
      dragEvent('dragover', items(root)[1], 80); // after itself = same place
      dragEvent('drop', items(root)[1]);
      expect(store.canUndo()).toBe(false);
    });

    it('cancelling a drag clears the indicator and moves nothing', async () => {
      const { fixture, root, store } = await openEditor();
      prepare(root);
      const ids = store.slides().map((s) => s.id);
      dragEvent('dragstart', items(root)[0]);
      dragEvent('dragover', items(root)[2], 80);
      dragEvent('dragend', items(root)[0]);
      await settle(fixture);
      expect(root.querySelector('.drop-after, .drop-before, .dragging')).toBeNull();
      expect(store.slides().map((s) => s.id)).toEqual(ids);
    });

    it('ignores a dragover that is not a slide drag (a file, say)', async () => {
      const { root } = await openEditor();
      prepare(root);
      expect(dragEvent('dragover', items(root)[1], 10).defaultPrevented).toBe(false);
    });
  });

  describe('thumbnails', () => {
    class FakeObserver {
      static all: FakeObserver[] = [];
      disconnected = false;
      constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {
        FakeObserver.all.push(this);
      }
      observe(): void {}
      disconnect(): void {
        this.disconnected = true;
      }
      fire(isIntersecting: boolean): void {
        this.callback([{ isIntersecting }]);
      }
    }

    it('draws a slide only while it is near the visible part of the list', async () => {
      FakeObserver.all = [];
      vi.stubGlobal('IntersectionObserver', FakeObserver);
      const { fixture, root } = await openEditor({ slides: 5 });
      const drawn = () => root.querySelectorAll('.sorter app-slide-renderer').length;
      expect(FakeObserver.all.length).toBeGreaterThanOrEqual(5);
      expect(drawn()).toBe(0);
      const observers = FakeObserver.all.slice(-5);
      observers[0].fire(true);
      observers[1].fire(true);
      await settle(fixture);
      expect(drawn()).toBe(2);
      observers[0].fire(false);
      await settle(fixture);
      expect(drawn()).toBe(1);
    });

    it('draws every thumbnail in thumbnail mode when the browser has no IntersectionObserver', async () => {
      vi.stubGlobal('IntersectionObserver', undefined);
      const { root } = await openEditor();
      const renderers = root.querySelectorAll('.sorter app-slide-renderer');
      expect(renderers).toHaveLength(3);
      expect(root.querySelector('.sorter .stage')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('measures its margin from the scrolling list, so thumbnails just outside it are ready before they show', async () => {
      const options: IntersectionObserverInit[] = [];
      vi.stubGlobal(
        'IntersectionObserver',
        class extends FakeObserver {
          constructor(callback: (entries: { isIntersecting: boolean }[]) => void, init: IntersectionObserverInit) {
            super(callback);
            options.push(init);
          }
        },
      );
      const { root } = await openEditor();
      expect(options.length).toBeGreaterThanOrEqual(3);
      for (const init of options) expect(init.root).toBe(root.querySelector('nav.sorter'));
      expect(options[0].rootMargin).toBe('240px 0px');
    });

    it('stops observing when the sorter goes away', async () => {
      FakeObserver.all = [];
      vi.stubGlobal('IntersectionObserver', FakeObserver);
      const { fixture } = await openEditor();
      fixture.destroy();
      expect(FakeObserver.all.filter((o) => o.disconnected).length).toBeGreaterThanOrEqual(3);
    });
  });

  it('has no AXE violations, with a section and the section form open', async () => {
    const { fixture, root } = await openEditor();
    root.querySelector<HTMLButtonElement>('.tools button[aria-haspopup]')!.click();
    await settle(fixture);
    typeInto(root.querySelector<HTMLInputElement>('#section-name')!, 'Intro');
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    root.querySelector<HTMLButtonElement>('.tools button[aria-haspopup]')!.click();
    await settle(fixture);
    const results = await runAxe(root.querySelector('app-slide-sorter')!);
    expect(results.violations).toEqual([]);
  });
});
