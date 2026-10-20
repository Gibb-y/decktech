import { DatePipe } from '@angular/common';
import { Component, Injector, afterNextRender, computed, inject, linkedSignal, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { DeckSummary } from '../core/persistence';
import { FocusTrap, LiveAnnouncer } from '../shared';
import { DeckLibrary } from './deck-library';

/** Decks drawn at once; the rest is added with "Show more" so a long list opens fast (arc42 Q11). */
export const PAGE_SIZE = 60;

/** Home screen: list, search, create, rename, duplicate and delete decks. */
@Component({
  selector: 'app-library-page',
  imports: [RouterLink, DatePipe, FocusTrap],
  templateUrl: './library-page.html',
  styleUrl: './library-page.css',
})
export class LibraryPage {
  protected readonly library = inject(DeckLibrary);
  private readonly router = inject(Router);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly injector = inject(Injector);

  protected readonly isoFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'";
  protected readonly query = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly renamingId = signal<string | null>(null);
  protected readonly renameDraft = signal('');
  protected readonly pendingDelete = signal<DeckSummary | null>(null);

  protected readonly matches = computed(() => {
    const needle = this.query().trim().toLowerCase();
    const decks = this.library.decks();
    return needle === '' ? decks : decks.filter((d) => d.title.toLowerCase().includes(needle));
  });
  /** Back to one page whenever the search changes. */
  private readonly shown = linkedSignal<string, number>({ source: this.query, computation: () => PAGE_SIZE });
  protected readonly visible = computed(() => this.matches().slice(0, this.shown()));
  protected readonly hidden = computed(() => this.matches().length - this.visible().length);
  protected readonly nextChunk = computed(() => Math.min(PAGE_SIZE, this.hidden()));
  protected readonly summary = computed(() => {
    const total = this.library.decks().length;
    const found = this.matches().length;
    if (total === 0) return '';
    return this.query().trim() === '' ? `${total} ${total === 1 ? 'deck' : 'decks'}` : `${found} of ${total} decks match`;
  });

  constructor() {
    void this.library.refresh().then((r) => {
      if (!r.ok) this.error.set(r.error.message);
    });
  }

  protected initialOf(title: string): string {
    return Array.from(title.trim())[0]?.toUpperCase() ?? '?';
  }

  protected setQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected showMore(): void {
    this.shown.update((n) => n + PAGE_SIZE);
  }

  protected async retry(): Promise<void> {
    const result = await this.library.refresh();
    this.error.set(result.ok ? null : result.error.message);
  }

  protected async createBlank(): Promise<void> {
    await this.open(await this.library.createBlank(), 'Blank deck created');
  }

  protected async createFromTemplate(templateId: string): Promise<void> {
    await this.open(await this.library.createFromTemplate(templateId), 'Deck created from template');
  }

  protected async duplicate(id: string): Promise<void> {
    const result = await this.library.duplicate(id);
    if (!result.ok) return this.fail(result.error.message);
    this.error.set(null);
    this.announcer.announce(`Duplicated as ${result.value.title}`);
    this.focus(`rename-btn-${result.value.id}`);
  }

  protected startRename(deck: DeckSummary): void {
    this.error.set(null);
    this.renamingId.set(deck.id);
    this.renameDraft.set(deck.title);
    this.focus(`rename-${deck.id}`);
  }

  protected setRenameDraft(event: Event): void {
    this.renameDraft.set((event.target as HTMLInputElement).value);
  }

  protected cancelRename(id: string): void {
    this.renamingId.set(null);
    this.focus(`rename-btn-${id}`);
  }

  protected async submitRename(event: Event, id: string): Promise<void> {
    event.preventDefault();
    const result = await this.library.rename(id, this.renameDraft());
    if (!result.ok) return this.fail(result.error.message);
    this.error.set(null);
    this.renamingId.set(null);
    this.announcer.announce('Deck renamed');
    this.focus(`rename-btn-${id}`);
  }

  protected askDelete(deck: DeckSummary): void {
    this.pendingDelete.set(deck);
  }

  protected cancelDelete(): void {
    this.pendingDelete.set(null);
  }

  protected async confirmDelete(): Promise<void> {
    const deck = this.pendingDelete();
    if (!deck) return;
    const result = await this.library.remove(deck.id);
    this.pendingDelete.set(null);
    if (!result.ok) return this.fail(result.error.message);
    this.error.set(null);
    this.announcer.announce(`Deleted ${deck.title}`);
    // The trigger is gone with the row; the dialog would restore focus to a removed button.
    this.focus('library-heading');
  }

  private async open(result: Awaited<ReturnType<DeckLibrary['createBlank']>>, announcement: string): Promise<void> {
    if (!result.ok) return this.fail(result.error.message);
    this.error.set(null);
    this.announcer.announce(announcement);
    await this.router.navigate(['/deck', result.value.id]);
  }

  private fail(message: string): void {
    this.error.set(message);
    this.announcer.announce(message);
  }

  private focus(id: string): void {
    afterNextRender(() => document.getElementById(id)?.focus(), { injector: this.injector });
  }
}
