import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { sourceLevelsForWord } from "../dist/word-tooltip.js";

const sources = JSON.parse(await readFile(new URL("../dist/data/word-game-sources.json", import.meta.url)));
const readShard = async letter => JSON.parse(gunzipSync(await readFile(new URL(`../dist/data/word-level-sources/${letter}.json.gz`, import.meta.url))));

test("Zen details show exactly t1 and t3 with their real level numbers and roles", async () => {
  const matches = sourceLevelsForWord(sources, await readShard("i"), " if ");
  assert.deepEqual(matches.map(game => game.name), ["Zen Word"]);
  const zen = matches.find(game => game.name === "Zen Word");
  assert.deepEqual(zen.configs.map(config => config.id), ["t1", "t3"]);
  const ios = zen.configs.find(config => config.id === "t1");
  assert.deepEqual(ios.locations.filter(location => location.roles.includes("目标词")).map(location => location.number), [1]);
  assert.equal(ios.locations[0].id, "1cc080b2c66507ef8dd0c4b0a57e06ed");
  assert.equal(ios.locations[0].label, "第 1 关");
  assert.ok(ios.locations.some(location => location.number === 57 && location.roles.includes("仅额外")));
});

test("Zen shows t1 and t3 while Word Tiles retains every source version", async () => {
  const groups = sourceLevelsForWord(sources, await readShard("i"), "ICE");
  assert.deepEqual(groups.map(game => game.id), ["06_Zen_Word", "07_Word_Tiles"]);
  assert.deepEqual(groups[0].configs.map(config => config.id), ["t1", "t3"]);
  assert.deepEqual(groups[1].configs.map(config => config.id), ["list0", "list5"]);
  assert.equal(groups[1].configs[0].locations[0].number, 1);
  assert.equal(groups[1].configs[0].locations[0].id, "191596");
  assert.equal(groups[0].configs[0].locations[0].number, 39);
});

test("sharded and unmapped resources use their real identifiers, and roles on one source merge", () => {
  const index = { source: { datasetHash: "same" }, games: [{ id: "06_Zen_Word", configs: [
    { id: "t1", label: "资源", levelKind: "sharded", sourceAliases: ["a", "b"] },
    { id: "t3", label: "未映射", levelKind: "pid" },
  ] }] };
  const shard = { datasetHash: "same", entries: { CAT: [[0, 0, [[9, "0:9", 3, 0]]], [0, 1, [[null, "resource-42", 8]]]] } };
  const groups = sourceLevelsForWord(index, shard, "CAT");
  const first = groups[0].configs[0].locations[0];
  assert.equal(first.label, "分片 0 · 序号 9");
  assert.deepEqual(first.roles, ["目标词", "额外词"]);
  assert.deepEqual(groups[0].configs[0].sourceAliases, ["a", "b"]);
  assert.equal(groups[0].configs[1].locations[0].label, "未映射关卡（ID resource-42）");
  assert.deepEqual(groups[0].configs[1].locations[0].roles, ["奖励词"]);
  assert.deepEqual(sourceLevelsForWord(index, shard, "MISSING"), []);
  assert.throws(() => sourceLevelsForWord(index, { ...shard, datasetHash: "stale" }, "CAT"), /版本不一致/);
});

test("every shipped source shard matches its local snapshot and covers the full game-source index", async () => {
  const found = new Map();
  assert.equal(sources.provenance.sources.length, 2);
  assert.deepEqual(sources.provenance.gameIds, ["06_Zen_Word", "07_Word_Tiles"]);
  assert.deepEqual(sources.provenance.roles, ["target", "extra", "onlyExtra", "bonus"]);
  for (const file of Object.values(sources.provenance.files)) {
    const bytes = await readFile(new URL(`../dist/data/word-level-sources/${file.file}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    assert.deepEqual(bytes, await readFile(new URL(`../data/source/word-level-sources/${file.file}`, import.meta.url)));
    const shard = JSON.parse(gunzipSync(bytes));
    assert.equal(shard.datasetHash, sources.source.datasetHash);
    assert.equal(Object.keys(shard.entries).length, file.wordCount);
    for (const [word, entries] of Object.entries(shard.entries)) {
      let mask = 0;
      for (const [game, config, locations] of entries) {
        assert.ok(sources.games[game].configs[config]);
        assert.ok(locations.length > 0);
        assert.ok(locations.every(location => Number.isInteger(location[2]) && location[2] > 0 && location[2] < 16));
        mask |= 1 << game;
      }
      assert.equal(found.has(word), false);
      found.set(word, mask);
    }
  }
  const mask = sources.games.reduce((value, game, index) => value | (["06_Zen_Word", "07_Word_Tiles"].includes(game.id) ? 1 << index : 0), 0);
  assert.deepEqual(Object.fromEntries(found), Object.fromEntries(Object.entries(sources.entries).filter(([, value]) => value & mask).map(([word, value]) => [word, value & mask])));
});
