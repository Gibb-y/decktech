import { Service, inject } from '@angular/core';
import { BUILT_IN_THEMES, FONT_FAMILY, type Theme } from '../core/model';
import { DeckRepository } from '../core/persistence';
import { AddAsset, Batch, CommandError, DeckStore, SetTheme, type Command } from '../core/store';
import { LiveAnnouncer } from '../shared';

const FONT_MIME: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };

/** Id of the built-in theme whose colours the theme has, or `null` for a custom one. */
export function builtInThemeId(theme: Theme): string | null {
  const match = BUILT_IN_THEMES.find((b) => Object.entries(b.theme.colors).every(([k, v]) => theme.colors[k] === v));
  return match?.id ?? null;
}

/**
 * Theme changes from the editor. Choosing a built-in theme swaps colours, type scale and spacing
 * but keeps the deck's fonts (and embedded font files), so a restyle never undoes font choices.
 * Each action is one command (one undo step) and announces its outcome.
 */
@Service()
export class ThemeActions {
  private readonly store = inject(DeckStore);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly repository = inject(DeckRepository, { optional: true });

  applyBuiltIn(id: string): void {
    const built = BUILT_IN_THEMES.find((b) => b.id === id);
    if (!built) return;
    const current = this.store.deck().theme;
    // Colours the built-in theme lacks (an imported deck's own tokens) stay, so nothing dangles.
    const next: Theme = { ...structuredClone(built.theme), colors: { ...current.colors, ...built.theme.colors }, fonts: { ...current.fonts } };
    if (current.fontFaces) next.fontFaces = [...current.fontFaces];
    if (this.run(new SetTheme(next))) this.announcer.announce(`${built.name} theme applied`);
  }

  /** Embeds a font file: stored as an asset, registered as a family and added to the theme's fonts under that name. */
  async addFont(file: File): Promise<boolean> {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    const family = file.name.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9 _-]+/g, ' ').trim().slice(0, 64);
    if (!(extension in FONT_MIME) || !FONT_FAMILY.test(family)) {
      this.announcer.announce('Choose a .woff2, .woff, .ttf or .otf font file');
      return false;
    }
    if (!this.repository) {
      this.announcer.announce('Fonts cannot be stored in this session');
      return false;
    }
    const stored = await this.repository.putAsset(new Blob([file], { type: FONT_MIME[extension] }));
    if (!stored.ok) {
      this.announcer.announce(`The font could not be stored: ${stored.error.message}`);
      return false;
    }
    const { ref } = stored.value;
    const theme = this.store.deck().theme; // read after the await: the author may have edited meanwhile
    const key = family.replace(/\s+/g, '-');
    const next: Theme = {
      ...theme,
      fonts: { ...theme.fonts, [key]: `"${family}", sans-serif` },
      fontFaces: [...(theme.fontFaces ?? []).filter((f) => f.family !== family), { family, assetId: ref.hash }],
    };
    const commands: Command[] = Object.hasOwn(this.store.deck().assets, ref.hash) ? [] : [new AddAsset(ref.hash, ref)];
    if (!this.run(new Batch('Add font', [...commands, new SetTheme(next)]))) return false;
    this.announcer.announce(`Font “${family}” added; choose it under Font for a text element`);
    return true;
  }

  pickFont(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.woff2,.woff,.ttf,.otf';
    input.addEventListener('change', () => {
      const [file] = Array.from(input.files ?? []);
      if (file) void this.addFont(file);
    });
    input.click();
  }

  private run(command: Command): boolean {
    try {
      this.store.execute(command);
      return true;
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      this.announcer.announce(e.message);
      return false;
    }
  }
}
