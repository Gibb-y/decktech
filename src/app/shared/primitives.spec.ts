import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import axe from 'axe-core';
import { Dialog } from './dialog';
import { Icon } from './icon';
import { ICONS, ICON_NAMES, type IconName } from './icons';
import { Notice, type NoticeKind } from './notice';
import { Tabs, panelId, tabId } from './tabs';
import { Tooltip, ariaKeyShortcuts } from './tooltip';

// Colour contrast needs real styles and layout, which jsdom has not; the token pairs are checked by `npm run lint:tokens`.
const AXE = { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } };

async function violations(root: HTMLElement): Promise<string[]> {
  document.body.append(root);
  try {
    const results = await axe.run(root, AXE);
    return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
  } finally {
    root.remove();
  }
}

afterEach(() => {
  vi.useRealTimers();
  document.body.querySelectorAll('.tooltip').forEach((t) => t.remove());
});

describe('Icon', () => {
  @Component({ imports: [Icon], template: `<app-icon [name]="name()" />` })
  class Host {
    readonly name = signal<IconName>('plus');
  }

  it('draws an aria-hidden svg from currentColor strokes', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const svg = (fixture.nativeElement as HTMLElement).querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.querySelector('path')!.getAttribute('d')).toBe(ICONS.plus);
  });

  it('follows its name, and draws nothing for an inherited one', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    fixture.componentInstance.name.set('trash');
    fixture.detectChanges();
    const path = (fixture.nativeElement as HTMLElement).querySelector('path')!;
    expect(path.getAttribute('d')).toBe(ICONS.trash);
    fixture.componentInstance.name.set('toString' as IconName);
    fixture.detectChanges();
    expect(path.getAttribute('d')).toBe('');
  });

  it('has a few dozen icons whose paths are well formed and distinct', () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(30);
    const paths = ICON_NAMES.map((n) => ICONS[n]);
    for (const d of paths) expect(d).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('Tooltip', () => {
  @Component({
    imports: [Tooltip, Icon],
    template: `
      <div (keydown.escape)="outer.set(outer() + 1)">
        @if (shown()) {
          <button id="icon" type="button" class="btn btn-icon" appTooltip="Bold" appTooltipShortcut="Ctrl+B"><app-icon name="bold" /></button>
          <button id="named" type="button" class="btn" aria-label="Already named" appTooltip="Other"><app-icon name="bold" /></button>
          <button id="text" type="button" class="btn" appTooltip="Hint">Visible text</button>
        }
      </div>
    `,
  })
  class Host {
    readonly shown = signal(true);
    readonly outer = signal(0);
  }

  function setup(fake = true): { fixture: ComponentFixture<Host>; el: HTMLElement; button: (id: string) => HTMLButtonElement } {
    if (fake) vi.useFakeTimers();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    document.body.append(el);
    return { fixture, el, button: (id) => el.querySelector<HTMLButtonElement>(`#${id}`)! };
  }
  const focus = (b: HTMLElement) => b.focus();
  const tips = () => [...document.body.querySelectorAll<HTMLElement>('.tooltip')];

  it('names an icon-only button from its text, and leaves buttons that already have a name', async () => {
    const { fixture, button } = setup();
    await fixture.whenStable();
    expect(button('icon').getAttribute('aria-label')).toBe('Bold');
    expect(button('named').getAttribute('aria-label')).toBe('Already named');
    expect(button('text').hasAttribute('aria-label')).toBe(false);
  });

  it('exposes the shortcut as aria-keyshortcuts', () => {
    const { button } = setup();
    expect(button('icon').getAttribute('aria-keyshortcuts')).toBe('Control+B');
    expect(button('text').hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(ariaKeyShortcuts('Ctrl+Shift+Z')).toBe('Control+Shift+Z');
    expect(ariaKeyShortcuts('Cmd+K')).toBe('Meta+K');
    expect(ariaKeyShortcuts('Esc')).toBe('Escape');
  });

  it('shows after a delay on hover, with the shortcut as kbd, and hides after leaving', async () => {
    const { button } = setup();
    button('icon').dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(100);
    expect(tips()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(tips()).toHaveLength(1);
    const tip = tips()[0];
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.firstChild!.textContent).toBe('Bold');
    expect(tip.querySelector('kbd.kbd')!.textContent).toBe('Ctrl+B');
    button('icon').dispatchEvent(new MouseEvent('mouseleave'));
    await vi.advanceTimersByTimeAsync(200);
    expect(tips()).toHaveLength(0);
  });

  it('stays while the pointer moves onto it', async () => {
    const { button } = setup();
    button('icon').dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(500);
    button('icon').dispatchEvent(new MouseEvent('mouseleave'));
    await vi.advanceTimersByTimeAsync(50);
    tips()[0].dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(500);
    expect(tips()).toHaveLength(1);
    tips()[0].dispatchEvent(new MouseEvent('mouseleave'));
    await vi.advanceTimersByTimeAsync(200);
    expect(tips()).toHaveLength(0);
  });

  it('never shows if the pointer leaves before the delay', async () => {
    const { button } = setup();
    button('icon').dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(100);
    button('icon').dispatchEvent(new MouseEvent('mouseleave'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(tips()).toHaveLength(0);
  });

  it('shows on keyboard focus at once, and a blur or click hides it', () => {
    const { button } = setup();
    focus(button('icon'));
    expect(tips()).toHaveLength(1);
    button('icon').blur();
    expect(tips()).toHaveLength(0);
    focus(button('icon'));
    button('icon').click();
    expect(tips()).toHaveLength(0);
  });

  it('does not show for focus that a mouse press caused', () => {
    const { button } = setup();
    button('icon').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    focus(button('icon'));
    expect(tips()).toHaveLength(0);
    button('icon').blur();
    focus(button('icon'));
    expect(tips()).toHaveLength(1);
  });

  it('shows one tooltip at a time per control', () => {
    const { button } = setup();
    focus(button('icon'));
    button('icon').dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(1000);
    expect(tips()).toHaveLength(1);
  });

  it('is dismissed by Escape without closing what is around it; Escape alone passes through', () => {
    const { fixture, button } = setup();
    focus(button('icon'));
    button('icon').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tips()).toHaveLength(0);
    expect(fixture.componentInstance.outer()).toBe(0);
    button('icon').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(fixture.componentInstance.outer()).toBe(1);
  });

  it('is removed with its control, and its timers with it', async () => {
    const { fixture, button } = setup();
    focus(button('icon'));
    button('text').dispatchEvent(new MouseEvent('mouseenter'));
    fixture.componentInstance.shown.set(false);
    fixture.detectChanges();
    expect(tips()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tips()).toHaveLength(0);
  });

  it('keeps inside the viewport', () => {
    const { button } = setup();
    vi.spyOn(button('icon'), 'getBoundingClientRect').mockReturnValue({ left: 0, right: 10, top: 0, bottom: 10, width: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) });
    focus(button('icon'));
    expect(parseFloat(tips()[0].style.left)).toBeGreaterThanOrEqual(4);
    expect(parseFloat(tips()[0].style.top)).toBeGreaterThan(10);
  });

  it('passes AXE', async () => {
    const { fixture } = setup(false);
    expect(await violations(fixture.nativeElement as HTMLElement)).toEqual([]);
  });
});

describe('Dialog', () => {
  @Component({
    imports: [Dialog],
    template: `
      <div (keydown.escape)="outer.set(outer() + 1)">
        <app-dialog heading="Rename deck" (closed)="closes.set(closes() + 1)">
          <label for="name">Name</label>
          <input id="name" class="input" data-autofocus />
          <ng-container dialog-footer>
            <button type="button" class="btn">Cancel</button>
            <button type="button" class="btn btn-primary">Save</button>
          </ng-container>
        </app-dialog>
      </div>
    `,
  })
  class Host {
    readonly closes = signal(0);
    readonly outer = signal(0);
  }

  async function open(): Promise<{ fixture: ComponentFixture<Host>; el: HTMLElement }> {
    const fixture = TestBed.createComponent(Host);
    document.body.append(fixture.nativeElement);
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('is a modal dialog named by its heading, with the content and footer in place', async () => {
    const { el, fixture } = await open();
    const panel = el.querySelector('[role="dialog"]')!;
    expect(panel.getAttribute('aria-modal')).toBe('true');
    const title = el.querySelector('h2')!;
    expect(title.textContent).toBe('Rename deck');
    expect(panel.getAttribute('aria-labelledby')).toBe(title.id);
    expect(el.querySelector('.dialog-body input')).not.toBeNull();
    expect([...el.querySelectorAll('.dialog-footer button')].map((b) => b.textContent!.trim())).toEqual(['Cancel', 'Save']);
    fixture.destroy();
  });

  it('moves focus to the marked control', async () => {
    const { el, fixture } = await open();
    expect(document.activeElement).toBe(el.querySelector('#name'));
    fixture.destroy();
  });

  it('closes on Escape once, without reaching an outer handler', async () => {
    const { el, fixture } = await open();
    el.querySelector('#name')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(fixture.componentInstance.closes()).toBe(1);
    expect(fixture.componentInstance.outer()).toBe(0);
    fixture.destroy();
  });

  it('closes from the backdrop and from the close button, which is named', async () => {
    const { el, fixture } = await open();
    (el.querySelector('.dialog-backdrop') as HTMLElement).click();
    const close = el.querySelector<HTMLButtonElement>('.dialog-header button')!;
    expect(close.getAttribute('aria-label')).toBe('Close');
    close.click();
    expect(fixture.componentInstance.closes()).toBe(2);
    fixture.destroy();
  });

  it('keeps Tab inside', async () => {
    const { el, fixture } = await open();
    const buttons = el.querySelectorAll<HTMLButtonElement>('.dialog-footer button');
    buttons[1].focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    buttons[1].dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(el.querySelector('.dialog-header button'));
    fixture.destroy();
  });

  it('passes AXE', async () => {
    const { el, fixture } = await open();
    el.remove();
    expect(await violations(el)).toEqual([]);
    fixture.destroy();
  });
});

describe('Tabs', () => {
  const TABS = [
    { id: 'html', label: 'HTML' },
    { id: 'css', label: 'CSS' },
    { id: 'js', label: 'JS' },
  ];

  @Component({
    imports: [Tabs],
    template: `
      <app-tabs [tabs]="tabs" label="Code" idPrefix="ed" [(selected)]="current" />
      @for (tab of tabs; track tab.id) {
        @if (tab.id === current()) {
          <div role="tabpanel" [id]="panelId('ed', tab.id)" [attr.aria-labelledby]="tabId('ed', tab.id)">{{ tab.label }} panel</div>
        }
      }
    `,
  })
  class Host {
    readonly tabs = TABS;
    readonly current = signal('html');
    readonly panelId = panelId;
    readonly tabId = tabId;
  }

  function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const tabs = () => [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const press = (key: string) => {
      (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      fixture.detectChanges();
    };
    return { fixture, el, tabs, press };
  }

  it('is a labelled tab list with one tab stop and links to the panel', () => {
    const { el, tabs } = setup();
    expect(el.querySelector('[role="tablist"]')!.getAttribute('aria-label')).toBe('Code');
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    const panel = el.querySelector('[role="tabpanel"]')!;
    expect(tabs()[0].getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs()[0].id);
  });

  it('selects on click', () => {
    const { fixture, tabs } = setup();
    tabs()[2].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.current()).toBe('js');
    expect(tabs()[2].getAttribute('aria-selected')).toBe('true');
  });

  it('moves and selects with the arrow keys, wrapping, and with Home and End', () => {
    const { fixture, tabs, press } = setup();
    tabs()[0].focus();
    press('ArrowRight');
    expect(fixture.componentInstance.current()).toBe('css');
    expect(document.activeElement).toBe(tabs()[1]);
    press('End');
    expect(fixture.componentInstance.current()).toBe('js');
    press('ArrowRight');
    expect(fixture.componentInstance.current()).toBe('html');
    press('ArrowLeft');
    expect(fixture.componentInstance.current()).toBe('js');
    press('Home');
    expect(fixture.componentInstance.current()).toBe('html');
    expect(document.activeElement).toBe(tabs()[0]);
  });

  it('ignores other keys and leaves them to the page', () => {
    const { fixture, tabs } = setup();
    tabs()[0].focus();
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    tabs()[0].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(fixture.componentInstance.current()).toBe('html');
  });

  it('passes AXE', async () => {
    const { el } = setup();
    expect(await violations(el)).toEqual([]);
  });
});

describe('Notice', () => {
  @Component({
    imports: [Notice],
    template: `
      @for (kind of kinds; track kind) {
        <app-notice [kind]="kind">Message {{ kind }}</app-notice>
      }
    `,
  })
  class Host {
    readonly kinds: NoticeKind[] = ['info', 'success', 'warning', 'danger'];
  }

  it.each([
    ['info', 'status', 'Note: '],
    ['success', 'status', 'Success: '],
    ['warning', 'alert', 'Warning: '],
    ['danger', 'alert', 'Error: '],
  ] as const)('%s is announced as %s and says its kind in words', (kind, role, prefix) => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const notice = (fixture.nativeElement as HTMLElement).querySelector(`.notice-${kind}`)!;
    expect(notice.getAttribute('role')).toBe(role);
    expect(notice.querySelector('.sr-only')!.textContent).toBe(prefix);
    expect(notice.textContent).toContain(`Message ${kind}`);
    expect(notice.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('passes AXE', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    expect(await violations(fixture.nativeElement as HTMLElement)).toEqual([]);
  });
});

describe('button, control and badge classes', () => {
  @Component({
    imports: [Icon, Tooltip],
    template: `
      <div>
        <button type="button" class="btn btn-primary">Save</button>
        <button type="button" class="btn">Cancel</button>
        <button type="button" class="btn btn-quiet btn-sm">Later</button>
        <button type="button" class="btn btn-danger btn-lg">Delete</button>
        <button type="button" class="btn btn-quiet btn-icon" appTooltip="Italic" appTooltipShortcut="Ctrl+I"><app-icon name="italic" /></button>
        <button type="button" class="btn btn-quiet btn-icon" aria-pressed="true" appTooltip="Underline"><app-icon name="underline" /></button>
        <button type="button" class="btn" aria-disabled="true">Unavailable</button>
        <button type="button" class="btn" disabled>Disabled</button>
        <label class="field"><span class="field-label">Width</span><input class="input" type="number" value="10" /></label>
        <label class="field"><span class="field-label">Layout</span><select class="input"><option>Title</option></select></label>
        <label class="check"><input type="checkbox" /> Locked</label>
        <span class="badge badge-success">Trusted</span>
        <kbd class="kbd">Ctrl</kbd>
      </div>
    `,
  })
  class Host {}

  it('are plain markup that passes AXE', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(await violations(fixture.nativeElement as HTMLElement)).toEqual([]);
  });
});
