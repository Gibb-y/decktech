import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FocusTrap } from './focus-trap';
import { LiveAnnouncer, LiveRegion } from './live-announcer';
import { SkipLink } from './skip-link';

describe('LiveAnnouncer', () => {
  afterEach(() => vi.useRealTimers());

  it('renders messages in a polite status region, and repeats identical text', async () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(LiveRegion);
    const announcer = TestBed.inject(LiveAnnouncer);
    const region = (fixture.nativeElement as HTMLElement).querySelector('[role="status"]')!;
    expect(region.getAttribute('aria-live')).toBe('polite');

    announcer.announce('Saved');
    await vi.advanceTimersByTimeAsync(60);
    fixture.detectChanges();
    expect(region.textContent).toBe('Saved');

    announcer.announce('Saved');
    expect(announcer.message()).toBe('');
    await vi.advanceTimersByTimeAsync(60);
    expect(announcer.message()).toBe('Saved');
  });
});

describe('SkipLink', () => {
  it('is a link that moves focus to the target without navigating', () => {
    @Component({
      imports: [SkipLink],
      template: `<app-skip-link /><main id="main-content" tabindex="-1"></main>`,
    })
    class Host {}
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    const link = (fixture.nativeElement as HTMLElement).querySelector('a')!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('main-content');
    fixture.nativeElement.remove();
  });
});

describe('FocusTrap', () => {
  @Component({
    imports: [FocusTrap],
    template: `
      <button id="outside">outside</button>
      @if (open()) {
        <div appFocusTrap id="trap"><button id="a">a</button><button id="b" disabled>b</button><button id="c">c</button></div>
      }
    `,
  })
  class Host {
    readonly open = signal(false);
  }

  async function mount() {
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    const outside = document.getElementById('outside')!;
    outside.focus();
    fixture.componentInstance.open.set(true);
    await fixture.whenStable();
    return { fixture, outside };
  }

  it('focuses the first control, wraps Tab in both directions, skips disabled controls', async () => {
    const { fixture } = await mount();
    expect(document.activeElement?.id).toBe('a');
    const tab = (shiftKey: boolean) => {
      const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(tab(true)).toBe(true);
    expect(document.activeElement?.id).toBe('c');
    expect(tab(false)).toBe(true);
    expect(document.activeElement?.id).toBe('a');
    document.getElementById('a')!.focus();
    expect(tab(false)).toBe(false); // in the middle, the browser moves focus itself
    fixture.nativeElement.remove();
  });

  it('returns focus to the opener when it goes away', async () => {
    const { fixture, outside } = await mount();
    fixture.componentInstance.open.set(false);
    await fixture.whenStable();
    expect(document.activeElement).toBe(outside);
    fixture.nativeElement.remove();
  });
});
