import { TestBed } from '@angular/core/testing';
import axe from 'axe-core';
import { COLOR_SCHEME_KEY, ColorScheme, ColorSchemeSwitch, DEFAULT_COLOR_SCHEME, isColorSchemeMode } from './color-scheme';

const root = document.documentElement;

function fresh(): ColorScheme {
  TestBed.resetTestingModule();
  return TestBed.inject(ColorScheme);
}

describe('ColorScheme', () => {
  beforeEach(() => {
    localStorage.clear();
    root.removeAttribute('data-theme');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    root.removeAttribute('data-theme');
  });

  it('starts with the default and applies it', () => {
    const scheme = fresh();
    expect(scheme.mode()).toBe(DEFAULT_COLOR_SCHEME);
    expect(root.getAttribute('data-theme')).toBe(DEFAULT_COLOR_SCHEME);
  });

  it.each(['light', 'dark'] as const)('sets %s on the document and stores it', (mode) => {
    const scheme = fresh();
    scheme.set(mode);
    expect(scheme.mode()).toBe(mode);
    expect(root.getAttribute('data-theme')).toBe(mode);
    expect(localStorage.getItem(COLOR_SCHEME_KEY)).toBe(mode);
  });

  it('follows the system by removing the attribute', () => {
    const scheme = fresh();
    scheme.set('dark');
    scheme.set('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(COLOR_SCHEME_KEY)).toBe('system');
  });

  it('restores the stored choice in a new session', () => {
    fresh().set('dark');
    root.removeAttribute('data-theme');
    const again = fresh();
    expect(again.mode()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it.each(['purple', '', '__proto__', 'toString'])('ignores a stored value %j', (value) => {
    localStorage.setItem(COLOR_SCHEME_KEY, value);
    expect(fresh().mode()).toBe(DEFAULT_COLOR_SCHEME);
  });

  it('rejects an unknown mode without changing anything', () => {
    const scheme = fresh();
    scheme.set('dark');
    scheme.set('toString' as never);
    expect(scheme.mode()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(isColorSchemeMode('toString')).toBe(false);
  });

  it('still switches when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const scheme = fresh();
    expect(scheme.mode()).toBe(DEFAULT_COLOR_SCHEME);
    scheme.set('dark');
    expect(scheme.mode()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });
});

describe('ColorSchemeSwitch', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });
  afterEach(() => {
    localStorage.clear();
    root.removeAttribute('data-theme');
  });

  it('is a labelled select that changes and shows the mode', async () => {
    const fixture = TestBed.createComponent(ColorSchemeSwitch);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const select = el.querySelector('select')!;
    expect([...select.options].map((o) => o.textContent!.trim())).toEqual(['System', 'Light', 'Dark']);
    expect(select.value).toBe(DEFAULT_COLOR_SCHEME);

    select.value = 'dark';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(TestBed.inject(ColorScheme).mode()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(select.value).toBe('dark');

    document.body.append(el);
    const results = await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    el.remove();
    expect(results.violations).toEqual([]);
  });
});
