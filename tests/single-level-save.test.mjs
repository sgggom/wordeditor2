import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createDuplicateCheck, findDuplicateWords, generationContext, prepareGeneration, configDestination } from "../dist/level-rules.js";

// Exercise the actual generation and save event handlers without starting the UI.
const app = readFileSync(new URL("../dist/app.js", import.meta.url), "utf8");
const handlers = app.slice(app.indexOf('  generateButton.addEventListener("click",'),
  app.indexOf('  exportLevelsButton.addEventListener("click",'));
const noop = () => {};

function editor(activeId = 5, generated = { targetWords: [], extraWords: [], name: "NEW" }) {
  const callbacks = {};
  const savedLevels = Array.from({ length: 6 }, (_, index) => ({ id: index + 1,
    level: { targetWords: [], extraWords: [], name: `OLD-${index + 1}` } }));
  const state = {
    AbortController, structuredClone,
    generateButton: { addEventListener: (_, fn) => { callbacks.generate = fn; } },
    addLevelButton: { addEventListener: (_, fn) => { callbacks.save = fn; } },
    batchRunning: false, pathRepairRunning: false, activeConfigSource: null, activeConfigRecords: [], parametersChanged: false, editingShape: false, batchRunBar: {}, generating: false, savingLevel: false,
    updatingLevelList: false, fileView: null, presetView: null, levelLibraryReady: true,
    initialForwardInput: { valueAsNumber: 50 }, duplicateRangeInputs: {
      target: { valueAsNumber: 0 }, extra: { valueAsNumber: 0 } },
    configuredInitialForwardProbability: 50, configuredFilters: {},
    configuredDuplicateRanges: { target: 0, extra: 0 },
    configuredFixedWords: [], configuredFixedLayout: null,
    configuredDesiredTargetCount: 0, configuredFixedWordExemptions: [],
    savedLevels, activeSavedLevelId: activeId, savedLevelEdited: false,
    level: activeId === null ? null : structuredClone(savedLevels[activeId - 1].level),
    size: { rows: 3, columns: 4 }, location: { protocol: "http:" },
    errorMessage: {}, savedLevelError: {}, requestId: 0, generationController: null,
    document: { querySelectorAll: () => [] }, savedLevelList: { querySelector: () => null },
    isValidInitialForwardProbability: value => Number.isInteger(value),
    isValidDuplicateRange: value => Number.isInteger(value) && value >= 0,
    filtersFromInputs: () => ({}), defaultGenerationWorkers: () => 1,
    createDuplicateCheck, findDuplicateWords, generationContext, prepareGeneration, configDestination,
    currentGenerationConfig: () => ({ rows: 3, columns: 4, filters: {}, fixedWords: [], targetDuplicateRange: 0, extraDuplicateRange: 0 }),
    getGenerationClient: () => ({ generate: async () => generated }),
    getLevelStore: async () => ({ saveLevel: async (level, existing) =>
      ({ ...(existing ?? { id: 7 }), level }) }),
    render: noop, renderSavedLevels: noop, renderGenerationButton: noop, renderWords: noop,
    showError: message => { throw new Error(message); },
  };
  runInNewContext(handlers, state);
  return { state, ...callbacks };
}

test("regenerate and save replaces the selected fifth level without appending", async () => {
  const { state, generate, save } = editor();
  await generate();
  assert.equal(state.activeSavedLevelId, 5);
  assert.equal(state.savedLevelEdited, true);
  assert.equal(state.savedLevels[4].level.name, "OLD-5", "Generation remains an unsaved draft");
  await save();
  assert.equal(state.savedLevels.length, 6);
  assert.equal(state.savedLevels[4].id, 5);
  assert.equal(state.savedLevels[4].level.name, "NEW");
  assert.equal(state.savedLevelEdited, false);
  assert.deepEqual(Array.from(state.savedLevels, record => record.level.name),
    ["OLD-1", "OLD-2", "OLD-3", "OLD-4", "NEW", "OLD-6"]);
});

test("generation without a selection still saves as a new last level", async () => {
  const { state, generate, save } = editor(null);
  await generate();
  assert.equal(state.activeSavedLevelId, null);
  await save();
  assert.equal(state.savedLevels.length, 7);
  assert.equal(state.savedLevels[6].level.name, "NEW");
  assert.equal(state.activeSavedLevelId, 7);
});

test("generation returning no result preserves the selected saved level", async () => {
  const { state, generate } = editor(5, null);
  await generate();
  assert.equal(state.activeSavedLevelId, 5);
  assert.equal(state.savedLevelEdited, false);
  assert.equal(state.level.name, "OLD-5");
});

test("saving manual changes to an existing level rejects words repeated in earlier levels", async () => {
  const { state, save } = editor();
  state.savedLevels[0].level.targetWords = [{ word: "CAT" }];
  state.level.targetWords = [{ word: "CAT" }];
  state.savedLevelEdited = true;
  state.configuredDuplicateRanges.target = 20;
  await save();
  assert.equal(state.savedLevelError.hidden, false);
  assert.match(state.savedLevelError.textContent, /CAT/);
  assert.equal(state.savedLevelEdited, true);
  assert.equal(state.savedLevels[4].level.name, "OLD-5");
});

test("saving preserves the generator's recorded extra-word fallback", async () => {
  const { state, save } = editor();
  state.savedLevels[0].level.extraWords = [{ word: "CAT" }];
  state.level.extraWords = [{ word: "CAT" }];
  state.level.extraDuplicateFallback = { attempts: 100001, words: ["CAT"] };
  state.savedLevelEdited = true;
  state.configuredDuplicateRanges.extra = 20;
  await save();
  assert.equal(state.savedLevelEdited, false);
  assert.equal(state.savedLevels[4].level.extraWords[0].word, "CAT");
});
