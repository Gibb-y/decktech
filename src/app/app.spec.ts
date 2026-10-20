import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { App } from './app';
import { routes } from './app.routes';
import { DeckRepository, InMemoryDeckRepository, STORAGE_MANAGER } from './core/persistence';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: DeckRepository, useClass: InMemoryDeckRepository },
        { provide: STORAGE_MANAGER, useValue: null },
        provideRouter(routes, withComponentInputBinding()),
      ],
    }).compileComponents();
  });

  it('puts a skip link first and the routed page in a focusable main landmark', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.firstElementChild?.tagName).toBe('APP-SKIP-LINK');
    const main = el.querySelector('main')!;
    expect(main.id).toBe('main-content');
    expect(main.getAttribute('tabindex')).toBe('-1');
    expect(el.querySelector('[role="status"][aria-live="polite"]')).toBeTruthy();
  });

  it('shows the library at the root', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');
    expect(harness.routeNativeElement?.querySelector('h1')?.textContent).toBe('Your decks');
  });

  it.each([
    ['/deck/dk_1', 'Editor'],
    ['/deck/dk_1/present', 'Presentation'],
    ['/deck/dk_1/presenter-view', 'Presenter view'],
  ])('routes %s to %s with the deck id', async (url, heading) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    const page = harness.routeNativeElement!;
    expect(page.querySelector('h1')?.textContent).toBe(heading);
    expect(page.textContent).toContain('dk_1');
  });

  it('moves focus to the new page heading after navigation, but not on first load', async () => {
    const fixture = TestBed.createComponent(App);
    document.body.appendChild(fixture.nativeElement);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    await fixture.whenStable();
    expect(document.activeElement).toBe(document.body);
    await router.navigateByUrl('/deck/dk_1');
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement?.tagName).toBe('H1');
    expect(document.activeElement?.textContent).toBe('Editor');
    fixture.nativeElement.remove();
  });

  it('sends unknown URLs to the library', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/no/such/page');
    expect(TestBed.inject(Router).url).toBe('/');
  });
});

describe('routes', () => {
  it('are all lazy, so no feature is in the initial bundle', () => {
    const real = routes.filter((r) => r.redirectTo === undefined);
    expect(real.map((r) => r.path)).toEqual(['', 'deck/:id', 'deck/:id/present', 'deck/:id/presenter-view']);
    for (const route of real) {
      expect(route.component).toBeUndefined();
      expect(route.loadComponent ?? route.loadChildren).toBeTypeOf('function');
    }
  });
});
