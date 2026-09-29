import { describe, expect, it, vi } from 'vitest';
import { instagramFilterIsActive, summarizeInstagramFilter, validateFinderRanges, withTimeout } from './finder';

describe('Finder filter safeguards', () => {
  it('distinguishes unknown Instagram counts from verified out-of-range counts', () => {
    expect(summarizeInstagramFilter([undefined, undefined], 0, 5_000)).toEqual({ checked: 2, verified: 0, matched: 0 });
    expect(summarizeInstagramFilter([8_500, 12_000], 0, 5_000)).toEqual({ checked: 2, verified: 2, matched: 0 });
    expect(summarizeInstagramFilter([1_900, undefined, 8_500], 0, 5_000)).toEqual({ checked: 3, verified: 2, matched: 1 });
  });

  it('uses the same active-filter boundary as the Finder UI', () => {
    expect(instagramFilterIsActive(0, 5_000)).toBe(true);
    expect(instagramFilterIsActive(100, 100_000)).toBe(true);
    expect(instagramFilterIsActive(0, 100_000)).toBe(false);
  });

  it('rejects reversed ranges before starting discovery', () => {
    expect(validateFinderRanges({ minimumListeners: 25_000, maximumListeners: 10_000, minimumInstagramFollowers: 0, maximumInstagramFollowers: 5_000 })).toMatch(/monthly listeners/i);
    expect(validateFinderRanges({ minimumListeners: 10_000, maximumListeners: 25_000, minimumInstagramFollowers: 8_000, maximumInstagramFollowers: 5_000 })).toMatch(/Instagram followers/i);
  });

  it('settles timed-out work instead of leaving the Finder busy forever', async () => {
    vi.useFakeTimers();
    const result = withTimeout(new Promise<string>(() => undefined), 1_000, 'Finder timed out.');
    const assertion = expect(result).rejects.toThrow('Finder timed out.');
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    vi.useRealTimers();
  });
});
