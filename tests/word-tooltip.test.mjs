import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sourceGamesForWord, wordTooltipDetails } from "../dist/word-tooltip.js";

const bytes = await readFile(new URL("../dist/data/word-game-sources.json", import.meta.url));
const sources = JSON.parse(bytes);
const names = word => sourceGamesForWord(sources, word).map(game => game.name);

test("source games include all actual matches once and never infer a game from the word bank", () => {
  assert.deepEqual(names("PO"), ["Zen Word"]);
  assert.deepEqual(names("TI"), ["Word Connect Association", "Crossword Go!", "Zen Word"]);
  assert.deepEqual(names(" if "), ["Word Connect Association", "Crossword Go!", "Zen Word"]);
  assert.deepEqual(names("OK"), ["Word Connect Association"]);
  assert.deepEqual(names("OH"), []);
  assert.deepEqual(names("NOTAREALWORD"), []);
  assert.deepEqual(sourceGamesForWord(null, "IF"), []);
});

test("the local source snapshot and shipped index have matching hashes and valid game membership", async () => {
  assert.equal(sources.games.length, 7);
  assert.equal(new Set(sources.games.map(game => game.id)).size, 7);
  assert.equal(Object.keys(sources.entries).length, 32268);
  for (const mask of Object.values(sources.entries)) assert.ok(Number.isInteger(mask) && mask > 0 && mask < 128);
  assert.deepEqual(bytes, await readFile(new URL("../data/source/word-game-sources.json", import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL("../dist/data/word-bank.json", import.meta.url)));
  assert.equal(manifest.gameSources.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(manifest.gameSources.source, sources.source);
  assert.equal(sources.source.file, "data/game_vocab/catalog.json");
  assert.match(sources.source.sha256, /^[a-f0-9]{64}$/);
});

test("word cards preserve zero parameters, distinguish missing values and label the renamed bank", () => {
  const details = wordTooltipDetails(" of ", { word: "OF", scope: 0, emotion: 0, abbreviation: 0, rarityLevel: 1,
    phonetic: "/əv/", definitionZh: "……的", definitionEn: "belonging to" });
  assert.equal(details.word, "OF");
  assert.deepEqual(details.fields, [["所属词库", "2词库"], ["范围库", "2词库"], ["情绪类型", "中性情绪（0）"],
    ["是否缩写", "否（0）"], ["生僻档位", "1 档"]]);
  assert.equal(details.phonetic, "/əv/");
  assert.equal(details.definitionZh, "……的");
  const unknown = wordTooltipDetails("UNKNOWN", null);
  assert.deepEqual(unknown.fields, []);
  assert.equal(unknown.definitionEn, "暂无英文释义");
  const extra = wordTooltipDetails("WORD", { onlyExtra: true, scope: 2, emotion: null, rarityLevel: null });
  assert.equal(extra.fields[0][1], "仅额外词库");
  assert.equal(extra.fields[2][1], "未填写");
  assert.equal(extra.fields[4][1], "未填写");
});

test("long bilingual definitions remain bounded without changing the underlying word record", () => {
  const record = { definitionZh: "中".repeat(200), definitionEn: "a".repeat(1000) };
  const before = structuredClone(record);
  const details = wordTooltipDetails("WORD", record);
  assert.equal(details.definitionZh.length, 181);
  assert.equal(details.definitionEn.length, 481);
  assert.ok(details.definitionZh.endsWith("…") && details.definitionEn.endsWith("…"));
  assert.deepEqual(record, before);
});
