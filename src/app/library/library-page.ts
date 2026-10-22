import { DatePipe } from '@angular/common';
import { Component, Injector, afterNextRender, computed, inject, linkedSignal, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { DeckSummary } from '../core/persistence';
import { FocusTrap, LiveAnnouncer } from '../shared';
import type { ImportedDeck } from './archive';
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
  protected readonly deleteError = signal<string | null>(null);
  /** Result of the last import or export, shown in a polite status region. */
  protected readonly notice = signal<string | null>(null);
  /** The last imported deck, so the notice can link to it. */
  protected readonly imported = signal<ImportedDeck | null>(null);

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
    if (this.library.busy()) return;
    await this.open(await this.library.createBlank(), 'Blank deck created');
  }

  protected async createFromTemplate(templateId: string): Promise<void> {
    if (this.library.busy()) return;
    await this.open(await this.library.createFromTemplate(templateId), 'Deck created from template');
  }

  protected async duplicate(id: string): Promise<void> {
    if (this.library.busy()) return;
    const result = await this.library.duplicate(id);
    if (!result.ok) return this.fail(result.error.message);
    this.error.set(null);
    this.announcer.announce(`Duplicated as ${result.value.title}`);
    // The copy can be filtered out or beyond the first page; the heading is always there.
    this.focus(`rename-btn-${result.value.id}`, 'library-heading');
  }

  protected async importDeck(): Promise<void> {
    if (this.library.busy()) return;
    let file: File | null;
    try {
      file = await this.library.pickFile();
    } catch (e) {
      return this.fail(`Could not open the file dialog: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!file) return;
    const result = await this.library.importFile(file);
    if (!result.ok) {
      this.imported.set(null);
      this.notice.set(null);
      return this.fail(result.error.message);
    }
    this.error.set(null);
    const { deck, hasCode } = result.value;
    this.imported.set(result.value);
    const text = `Imported “${deck.title}”.${hasCode ? ' It contains code components, which stay switched off until you have read them and chosen what runs. Open the deck to do that.' : ''}`;
    this.notice.set(text);
    this.announcer.announce(text);
  }

  protected async exportDeck(deck: DeckSummary): Promise<void> {
    if (this.library.busy()) return;
    this.report(await this.library.exportDeck(deck.id), `Exported “${deck.title}”`);
  }

  protected async exportAll(): Promise<void> {
    if (this.library.busy()) return;
    this.report(await this.library.exportAll(), 'Exported all decks');
  }

  private report(result: Awaited<ReturnType<DeckLibrary['exportAll']>>, success: string): void {
    this.imported.set(null);
    if (!result.ok) {
      this.notice.set(null);
      return this.fail(result.error.message);
    }
    this.error.set(null);
    const { cancelled, skipped, fileName } = result.value;
    if (cancelled) return this.notice.set(null);
    const left = skipped.length > 0 ? ` Left out because they are from a newer version: ${skipped.join(', ')}.` : '';
    const text = `${success} to ${fileName}.${left}`;
    this.notice.set(text);
    this.announcer.announce(text);
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
    if (this.library.busy()) return;
    const result = await this.library.rename(id, this.renameDraft());
    if (!result.ok) return this.fail(result.error.message);
    this.error.set(null);
    this.renamingId.set(null);
    this.announcer.announce('Deck renamed');
    this.focus(`rename-btn-${id}`);
  }

  protected askDelete(deck: DeckSummary): void {
    this.deleteError.set(null);
    this.pendingDelete.set(deck);
  }

  protected cancelDelete(): void {
    const deck = this.pendingDelete();
    this.pendingDelete.set(null);
    // Some browsers do not focus a clicked button, so the trap cannot know where to return to.
    if (deck) this.focus(`delete-btn-${deck.id}`, 'library-heading');
  }

  protected async confirmDelete(): Promise<void> {
    const deck = this.pendingDelete();
    if (!deck || this.library.busy()) return;
    const result = await this.library.remove(deck.id);
    // The dialog stays open on failure so the user sees why and can retry or cancel.
    if (!result.ok) return this.deleteError.set(result.error.message);
    this.pendingDelete.set(null);
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

  /** Shown in the alert banner, which assistive technology announces by itself. */
  private fail(message: string): void {
    this.error.set(message);
  }

  private focus(id: string, fallbackId?: string): void {
    afterNextRender(
      () => (document.getElementById(id) ?? (fallbackId ? document.getElementById(fallbackId) : null))?.focus(),
      { injector: this.injector },
    );
  }
}
