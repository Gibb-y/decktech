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
    ['/deck/dk_1/presenter-view', 'Presenter view'],
  ])('routes %s to %s', async (url, heading) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    const page = harness.routeNativeElement!;
    expect(page.querySelector('h1')?.textContent).toBe(heading);
  });

  it('routes /deck/:id/present to the presentation page, which says it is opening the deck', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/deck/dk_1/present');
    const page = harness.routeNativeElement!;
    expect(page.querySelector('h1')?.textContent).toBe('Presentation');
    expect(page.textContent).toContain('Opening deck');
  });

  it('opens the editor route, headed "Editor" until the deck is open', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/deck/dk_1');
    expect(harness.routeNativeElement!.querySelector('h1')?.textContent).toBe('Editor');
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

  it('creates and opens the 100-element stress deck from the dev route', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/dev/stress');
    for (let i = 0; i < 20 && !TestBed.inject(Router).url.startsWith('/deck/'); i++) await new Promise((r) => setTimeout(r, 10));
    const router = TestBed.inject(Router);
    expect(router.url).toMatch(/^\/deck\/dk_/);
    const repo = TestBed.inject(DeckRepository);
    const id = router.url.split('/')[2];
    const loaded = await repo.load(id);
    expect(loaded.ok && !loaded.value.outcome.readOnly && loaded.value.outcome.deck.slides[0].elements.length).toBe(100);
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
    // `dev/stress` exists only in dev mode, which is what tests run in.
    expect(real.map((r) => r.path)).toEqual(['', 'deck/:id', 'deck/:id/present', 'deck/:id/presenter-view', 'preview', 'dev/stress']);
    for (const route of real) {
      expect(route.component).toBeUndefined();
      expect(route.loadComponent ?? route.loadChildren).toBeTypeOf('function');
    }
  });
});
