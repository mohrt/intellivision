import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackGameLoaded } from '../src/analytics';

describe('trackGameLoaded', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names bundled games', () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    trackGameLoaded('intellivision', 'Some Game');
    expect(gtag).toHaveBeenCalledWith('event', 'game_loaded', { system: 'intellivision', game: 'Some Game' });
  });

  it("doesn't name the player's own files", () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    trackGameLoaded('intellivision');
    expect(gtag).toHaveBeenCalledWith('event', 'game_loaded', { system: 'intellivision', game: 'own file' });
  });

  it('does nothing when the Google tag is missing', () => {
    expect(() => trackGameLoaded('intellivision', 'Some Game')).not.toThrow();
  });
});
