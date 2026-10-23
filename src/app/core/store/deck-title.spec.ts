import { createDeck, validateDeck } from '../model';
import { CommandError } from './command';
import { SetDeckTitle } from './commands';

describe('SetDeckTitle', () => {
  const deck = Object.freeze(createDeck('Old'));

  it('sets the trimmed title and keeps everything else', () => {
    const next = new SetDeckTitle('  New talk  ').do(deck).deck;
    expect(next.title).toBe('New talk');
    expect(next.slides).toBe(deck.slides);
    expect(validateDeck(next).ok).toBe(true);
  });

  it('is a no-op for the same title', () => {
    expect(new SetDeckTitle('Old').do(deck).deck).toBe(deck);
  });

  it.each([[''], ['   '], ['x'.repeat(1001)]])('refuses the title %j', (title) => {
    expect(() => new SetDeckTitle(title).do(deck)).toThrow(CommandError);
    expect(() => new SetDeckTitle(title).do(deck)).toThrow(/1 to 1000 characters/);
  });

  it('produces a patch that undoes the rename', () => {
    const { inverse, deck: next } = new SetDeckTitle('New').do(deck);
    expect(next.title).toBe('New');
    expect(inverse.length).toBeGreaterThan(0);
  });
});
