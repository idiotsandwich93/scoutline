export interface FinderRanges {
  minimumListeners: number;
  maximumListeners: number;
  minimumInstagramFollowers: number;
  maximumInstagramFollowers: number;
}

export interface InstagramFilterSummary {
  checked: number;
  verified: number;
  matched: number;
}

export function validateFinderRanges(ranges: FinderRanges): string | undefined {
  if (![ranges.minimumListeners, ranges.maximumListeners, ranges.minimumInstagramFollowers, ranges.maximumInstagramFollowers].every(Number.isFinite)) {
    return 'Enter valid numbers for every listener and follower filter.';
  }
  if (ranges.minimumListeners < 0 || ranges.maximumListeners < 0 || ranges.minimumInstagramFollowers < 0 || ranges.maximumInstagramFollowers < 0) {
    return 'Listener and follower filters cannot be negative.';
  }
  if (ranges.minimumListeners > ranges.maximumListeners) return 'Minimum monthly listeners cannot exceed the maximum.';
  if (ranges.minimumInstagramFollowers > ranges.maximumInstagramFollowers) return 'Minimum Instagram followers cannot exceed the maximum.';
  return undefined;
}

export function instagramFilterIsActive(minimum: number, maximum: number): boolean {
  return minimum > 0 || maximum < 100_000;
}

export function summarizeInstagramFilter(counts: Array<number | undefined>, minimum: number, maximum: number): InstagramFilterSummary {
  const verified = counts.filter((count): count is number => count !== undefined && Number.isFinite(count));
  return {
    checked: counts.length,
    verified: verified.length,
    matched: verified.filter((count) => count >= minimum && count <= maximum).length,
  };
}

export function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => { if (timeout) clearTimeout(timeout); });
}
