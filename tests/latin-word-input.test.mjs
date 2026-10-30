import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLatinWordInput } from "../dist/latin-word-input.js";

test("English input strips Chinese, digits and punctuation while preserving letter case and vacant slots", () => {
  assert.equal(normalizeLatinWordInput("中文ＡｂC123！ *_?"), "AbC**");
  assert.equal(normalizeLatinWordInput("clay"), "clay");
  assert.equal(normalizeLatinWordInput("地图"), "");
  assert.equal(normalizeLatinWordInput("*L*Y"), "*L*Y");
});

test("leading, trailing and repeated whitespace still each represent exactly one letter", () => {
  assert.equal(normalizeLatinWordInput(" L Y"), "*L*Y");
  assert.equal(normalizeLatinWordInput("L  Y "), "L**Y*");
  assert.equal(normalizeLatinWordInput(" L\tY　"), "*L*Y*");
});
