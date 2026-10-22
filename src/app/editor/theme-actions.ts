import { Service, inject } from '@angular/core';
import { BUILT_IN_THEMES, FONT_FAMILY, type Theme } from '../core/model';
import { DeckRepository } from '../core/persistence';
import { AddAsset, Batch, CommandError, DeckStore, SetTheme, type Command } from '../core/store';
import { LiveAnnouncer } from '../shared';

const FONT_MIME: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };

/** Id of the built-in theme whose colours, type scale and spacing the theme has (extra colours are fine), or `null` for a custom one. */
export function builtInThemeId(theme: Theme): string | null {
  const same = (a: object, b: object): boolean => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const match = BUILT_IN_THEMES.find(
    (b) =>
      Object.entries(b.theme.colors).every(([k, v]) => theme.colors[k] === v) &&
      same(b.theme.typeScale, theme.typeScale) &&
      same(b.theme.spacing, theme.spacing),
  );
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

  /**
   * Replaces the deck's theme with one made in the theme editor, as one undo step. Returns `null`
   * when it was applied, else the reason the deck gave (a token or font in use that the theme lacks, ...).
   */
  applyCustom(theme: Theme): string | null {
    try {
      this.store.execute(new SetTheme(theme));
    } catch (e) {
      if (!(e instanceof CommandError)) throw e;
      return e.message;
    }
    this.announcer.announce(theme.name ? `Theme “${theme.name}” applied` : 'Theme applied');
    return null;
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
    const stack = `"${family}", sans-serif`;
    // A file named like a theme font ("body.woff2") must not replace that font; re-adding a family is fine.
    if (Object.hasOwn(theme.fonts, key) && theme.fonts[key] !== stack) {
      this.announcer.announce(`The theme already has a font called “${key}”; rename the file and add it again`);
      return false;
    }
    const next: Theme = {
      ...theme,
      fonts: { ...theme.fonts, [key]: stack },
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
