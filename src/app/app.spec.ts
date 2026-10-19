import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { DeckRepository, InMemoryDeckRepository, STORAGE_MANAGER } from './core/persistence';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: DeckRepository, useClass: InMemoryDeckRepository },
        { provide: STORAGE_MANAGER, useValue: null },
      ],
    })
      .compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render title', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Hello, decktech');
  });
});
