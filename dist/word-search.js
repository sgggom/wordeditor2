export const normalizeWordSearch = value => String(value).replace(/\s/g, "*");

export function compileWordSearch(value) {
  const query = normalizeWordSearch(value);
  const upper = query.toUpperCase();
  const wildcard = upper.includes("*") && /^[A-Z*]+$/.test(upper);
  const pattern = wildcard ? upper.replaceAll("*", "[A-Z]") : null;
  const partial = wildcard ? new RegExp(pattern) : null;
  const exact = wildcard ? new RegExp(`^${pattern}$`) : null;
  const prefix = wildcard ? new RegExp(`^${pattern}`) : null;
  return {
    query,
    matches: entry => !query || (wildcard ? partial.test(entry.word)
      : entry.word.includes(upper) || String(entry.definitionZh ?? "").includes(query)),
    exact: entry => wildcard ? exact.test(entry.word) : entry.word === upper,
    startsWith: entry => wildcard ? prefix.test(entry.word) : entry.word.startsWith(upper),
  };
}
