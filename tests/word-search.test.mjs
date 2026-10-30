import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWordSearch, compileWordSearch } from "../dist/word-search.js";
const entry = word => ({ word });

test("leading, middle, trailing and repeated spaces each preserve one vacant letter position", () => {
  assert.equal(normalizeWordSearch(" L Y"), "*L*Y");
  assert.equal(normalizeWordSearch("L  Y "), "L**Y*");
  assert.equal(normalizeWordSearch(" L\tY　"), "*L*Y*");
  assert.equal(normalizeWordSearch("*L*Y"), "*L*Y");
});

test("a vacant slot consumes one letter and same-length matches rank ahead of longer substring matches", () => {
  const matcher = compileWordSearch(" L Y");
  assert.equal(matcher.query, "*L*Y");
  for (const word of ["CLAY", "FLAY", "PLAY", "SLAYS", "DELAY"]) assert.equal(matcher.matches(entry(word)), true, word);
  for (const word of ["FLY", "LILY", "ALWAYS", "LAZY"]) assert.equal(matcher.matches(entry(word)), false, word);
  const words = ["SLAYS", "CLAY", "DELAY", "FLAY"].map(entry)
    .sort((a, b) => Number(matcher.exact(b)) - Number(matcher.exact(a)) || a.word.localeCompare(b.word));
  assert.deepEqual(words.map(entry => entry.word), ["CLAY", "FLAY", "DELAY", "SLAYS"]);
});

test("wildcard-only queries match exactly the requested minimum slots and support lowercase", () => {
  const matcher = compileWordSearch("  ");
  assert.equal(matcher.exact(entry("AT")), true); assert.equal(matcher.exact(entry("CAT")), false);
  assert.equal(matcher.matches(entry("CAT")), true); assert.equal(matcher.matches(entry("A")), false);
  assert.equal(compileWordSearch("*l*y").exact(entry("CLAY")), true);
});

test("plain word and Chinese definition search keep their existing matching and exact-match priority", () => {
  const matcher = compileWordSearch("cat");
  assert.equal(matcher.exact(entry("CAT")), true); assert.equal(matcher.matches(entry("CATS")), true);
  assert.equal(matcher.startsWith(entry("CATS")), true); assert.equal(matcher.startsWith(entry("BOBCAT")), false);
  assert.equal(compileWordSearch("地图").matches({ word: "MAP", definitionZh: "地图，映射" }), true);
  assert.equal(compileWordSearch("").matches(entry("CAT")), true);
  assert.equal(compileWordSearch(".").matches(entry("CAT")), false);
});
