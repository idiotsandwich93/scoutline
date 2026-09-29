export function parseArtistNameList(value: string): string[] {
  const names = value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^['"]|['"]$/g, '').trim())
    .filter((line) => line.length > 1 && line.length < 100 && !/:$/.test(line) && !/^(artists?|here|note|list)\b/i.test(line));
  return [...new Set(names.map((name) => name.toLowerCase()))].map((normalized) => names.find((name) => name.toLowerCase() === normalized)!).slice(0, 25);
}
