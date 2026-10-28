import { createDuplicateCheck, findDuplicateWords, setTargetWord } from "./level-rules.js";
import { allocateTargetLengths, countTargetLengthPlan, targetLengthGroup } from "./level-generator.js";
import { TARGET_LENGTH_OPTIONS, MAX_TARGET_PLAN_SLOTS } from "./level-config.js";
import { renderTargetPlanChoices } from "./target-plan-controls.js";
import { setupConfigList } from "./config-list.js";
import { calculateRarityTotal } from "./level-statistics.js";
import { createBatchRunner, formatBatchState } from "./batch-runner.js";
import { createGenerationClient, defaultGenerationWorkers } from "./generation-client.js";
import { gameExportText } from "./level-export.js";
import { normalizeFixedWords, normalizeFixedLayout } from "./fixed-words.js";
import { createPathSafetyChecker } from "./path-safety.js";

(() => {
  "use strict";

  const DEFAULT_SIZE = Object.freeze({ rows: 3, columns: 4 });
  const LIMITS = Object.freeze({ rows: [2, 3], columns: [3, 5] });
  const STORAGE_KEY = "fangge.level-size.v1";
  const TARGET_STORAGE_KEY = "fangge.level-target-count.v1";
  const LEGACY_TARGET_RATIOS_STORAGE_KEY = "fangge.level-target-length-ratios.v1";
  const TARGET_PLAN_STORAGE_KEY = "fangge.level-target-length-plan.v1";
  const LEGACY_LENGTH_STORAGE_KEY = "fangge.level-max-word-length.v1";
  const LENGTH_STORAGE_KEY = "fangge.level-max-word-length.v2";
  const INITIAL_LENGTH_STORAGE_KEY = "fangge.level-initial-max-word-length.v1";
  const FORWARD_STORAGE_KEY = "fangge.level-initial-forward-probability.v1";
  const FILTER_STORAGE_KEY = "fangge.level-word-filters.v1";
  const FIXED_WORDS_STORAGE_KEY = "fangge.level-fixed-words.v1";
  const FIXED_LAYOUT_STORAGE_KEY = "fangge.level-fixed-layout.v1";
  const LEGACY_DUPLICATE_RANGE_STORAGE_KEY = "fangge.level-duplicate-check-range.v1";
  const DUPLICATE_RANGE_STORAGE_KEYS = {
    target: "fangge.level-target-duplicate-range.v1", extra: "fangge.level-extra-duplicate-range.v1",
  };
  const form = document.querySelector("#size-form");
  const board = document.querySelector("#board");
  const layout = document.querySelector("#board-layout");
  const boardStage = document.querySelector(".board-stage");
  const rowLabels = document.querySelector("#row-labels");
  const columnLabels = document.querySelector("#column-labels");
  const summary = document.querySelector("#size-summary");
  const count = document.querySelector("#cell-count");
  const emotionScore = document.querySelector("#emotion-score");
  const rarityScore = document.querySelector("#rarity-score");
  const levelDataButton = document.querySelector("#level-data-toggle");
  const levelDataPanel = document.querySelector("#level-data-panel");
  const levelDataContent = document.querySelector("#level-data-content");
  const addLevelButton = document.querySelector("#add-level-to-list");
  const exportLevelsButton = document.querySelector("#export-levels");
  const importLevelsButton = document.querySelector("#import-levels");
  const importLevelsFile = document.querySelector("#import-levels-file");
  const savedLevelList = document.querySelector("#saved-level-list");
  const savedLevelCount = document.querySelector("#saved-level-count");
  const savedLevelError = document.querySelector("#saved-level-error");
  const batchRunBar = document.querySelector("#batch-run-bar");
  const batchRunStatus = document.querySelector("#batch-run-status");
  const batchRunProgress = document.querySelector("#batch-run-progress");
  const stopBatchButton = document.querySelector("#stop-batch-run");
  const resetButton = document.querySelector("#reset-size");
  const generateButton = document.querySelector("#generate-level");
  const errorMessage = document.querySelector("#generation-error");
  const wordList = document.querySelector("#word-list");
  const wordCount = document.querySelector("#word-count");
  const targetWordCount = document.querySelector("#target-word-count");
  const extraWordCount = document.querySelector("#extra-word-count");
  const targetInput = document.querySelector("#target-count");
  const targetConfigButton = document.querySelector("#target-config-toggle");
  const targetConfigSummary = document.querySelector("#target-config-summary");
  const targetConfigPanel = document.querySelector("#target-config-panel");
  const targetConfigError = document.querySelector("#target-config-error");
  const targetPlanEnabled = document.querySelector("#target-plan-enabled");
  const targetPlanFields = document.querySelector("#target-plan-fields");
  const targetPlanSlots = document.querySelector("#target-plan-slots");
  const targetPlanSummary = document.querySelector("#target-plan-summary");
  const maxWordLengthInput = document.querySelector("#max-word-length");
  const initialMaxWordLengthInput = document.querySelector("#initial-max-word-length");
  const initialForwardInput = document.querySelector("#initial-forward-probability");
  const duplicateRangeInputs = {
    target: document.querySelector("#target-duplicate-range"), extra: document.querySelector("#extra-duplicate-range"),
  };
  const filterButton = document.querySelector("#filter-toggle");
  const filterSummary = document.querySelector("#filter-summary");
  const activeFixedWords = document.querySelector("#active-fixed-words");
  const fixedWordsSummary = document.querySelector("#fixed-words-summary");
  const filterInputs = [...document.querySelectorAll("input[data-word-filter]")];
  const filterOptions = Object.fromEntries(["scope", "emotion", "abbreviation", "rarityLevel"].map(key =>
    [key, filterInputs.filter(input => input.dataset.wordFilter === key).map(input => Number(input.value))]
  ));

  let size = readSize();
  let configuredTargetCount = readTargetCount();
  let configuredTargetLengthPlan = readTargetLengthPlan();
  let draftTargetLengthPlan = [];
  let configuredMaxWordLength = readMaxWordLength();
  let configuredInitialMaxWordLength = readMaxWordLength(INITIAL_LENGTH_STORAGE_KEY, LEGACY_LENGTH_STORAGE_KEY);
  let configuredInitialForwardProbability = readInitialForwardProbability();
  let configuredFilters = readFilters();
  let configuredFixedWords = readFixedWords();
  let configuredFixedLayout = readFixedLayout();
  let configuredDuplicateRanges = Object.fromEntries(Object.entries(DUPLICATE_RANGE_STORAGE_KEYS)
    .map(([kind, key]) => [kind, readDuplicateRange(key)]));
  let level = null;
  let selectedWord = null;
  let generationClient = null;
  let generationController = null;
  let requestId = 0;
  let generating = false;
  let generationAttempts = 0;
  let generationWorkers = 0;
  let displayedStatistics = null;
  let savedLevels = [];
  let activeSavedLevelId = null;
  let savedLevelEdited = false;
  let savedLevelsLoading = true;
  let levelLibraryReady = false;
  let savingLevel = false;
  let exportingLevels = false;
  let updatingLevelList = false;
  let batchRunning = false;
  let batchRunner = null;
  let savedLevelListDirty = true;
  let displayedSavedLevelId;
  let displayedLevelListBusy;
  let levelStorePromise;

  function isValidSize(size) {
    return size !== null && typeof size === "object" &&
      Object.entries(LIMITS).every(([dimension, [min, max]]) =>
        Number.isInteger(size[dimension]) && size[dimension] >= min && size[dimension] <= max
      );
  }

  function readSize() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved?.version === 1 && isValidSize(saved)) {
        return { rows: saved.rows, columns: saved.columns };
      }
    } catch {
      // Invalid saved data or unavailable storage must not prevent editing.
    }
    return { ...DEFAULT_SIZE };
  }

  function saveSize() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...size }));
      localStorage.setItem(TARGET_STORAGE_KEY, String(configuredTargetCount));
      localStorage.setItem(TARGET_PLAN_STORAGE_KEY, JSON.stringify(configuredTargetLengthPlan));
      localStorage.setItem(LENGTH_STORAGE_KEY, String(configuredMaxWordLength));
      localStorage.setItem(INITIAL_LENGTH_STORAGE_KEY, String(configuredInitialMaxWordLength));
      localStorage.setItem(FORWARD_STORAGE_KEY, String(configuredInitialForwardProbability));
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(configuredFilters));
      localStorage.setItem(FIXED_WORDS_STORAGE_KEY, JSON.stringify(configuredFixedWords));
      localStorage.setItem(FIXED_LAYOUT_STORAGE_KEY, JSON.stringify(configuredFixedLayout));
      for (const [kind, key] of Object.entries(DUPLICATE_RANGE_STORAGE_KEYS)) {
        localStorage.setItem(key, String(configuredDuplicateRanges[kind]));
      }
    } catch {
      // Keep editing available when browser storage is disabled.
    }
  }

  function getLevelStore() {
    if (!levelStorePromise) {
      levelStorePromise = import("./level-store.js").catch(error => {
        levelStorePromise = null;
        throw error;
      });
    }
    return levelStorePromise;
  }

  async function loadSavedLevels() {
    try {
      const store = await getLevelStore();
      savedLevels = await store.getSavedLevels();
      levelLibraryReady = true;
    } catch {
      savedLevelError.textContent = "关卡列表读取失败，请刷新重试。";
      savedLevelError.hidden = false;
    } finally {
      savedLevelsLoading = false;
      savedLevelListDirty = true;
      renderSavedLevels();
      renderGenerationButton();
    }
  }

  function renderSavedLevels() {
    const busy = generating || savingLevel || updatingLevelList || batchRunning;
    importLevelsButton.disabled = busy || exportingLevels || !levelLibraryReady;
    importLevelsButton.textContent = updatingLevelList ? "处理中…" : "导入关卡";
    savedLevelCount.textContent = String(savedLevels.length);
    exportLevelsButton.disabled = exportingLevels || savingLevel || updatingLevelList || batchRunning || !levelLibraryReady || !savedLevels.length;
    exportLevelsButton.textContent = exportingLevels ? "导出中…" : "导出关卡";
    addLevelButton.disabled = !level || busy || !levelLibraryReady || (activeSavedLevelId !== null && !savedLevelEdited);
    addLevelButton.textContent = savingLevel ? "保存中…" : activeSavedLevelId !== null
      ? (savedLevelEdited ? "保存修改" : "已加入") : "加入关卡列表";
    if (!savedLevelListDirty && displayedSavedLevelId === activeSavedLevelId && displayedLevelListBusy === busy) return;
    savedLevelListDirty = false;
    displayedSavedLevelId = activeSavedLevelId;
    displayedLevelListBusy = busy;
    const scrollTop = savedLevelList.scrollTop;
    const scrollLeft = savedLevelList.scrollLeft;
    const fragment = document.createDocumentFragment();
    if (!savedLevels.length) {
      const empty = document.createElement("p");
      empty.className = "saved-level-empty";
      empty.textContent = savedLevelsLoading ? "加载中…" : "暂无关卡";
      fragment.append(empty);
    }
    for (const [index, record] of savedLevels.entries()) {
      const saved = record.level;
      const card = document.createElement("div");
      card.className = "saved-level-card";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "saved-level-item";
      button.dataset.savedLevelId = String(record.id);
      button.disabled = updatingLevelList || batchRunning;
      if (saved.sourceConfig) button.title = `来自配置 ${String(saved.sourceConfig.position).padStart(3, "0")}`;
      button.setAttribute("aria-pressed", String(record.id === activeSavedLevelId));
      const heading = document.createElement("span");
      heading.className = "saved-level-item-heading";
      const name = document.createElement("strong");
      name.textContent = `关卡 ${String(index + 1).padStart(3, "0")}`;
      const dimensions = document.createElement("span");
      dimensions.className = "saved-level-size";
      dimensions.textContent = `${saved.rows} × ${saved.columns}`;
      heading.append(name, dimensions);
      const meta = document.createElement("span");
      meta.className = "saved-level-meta";
      meta.textContent = `目标词 ${saved.targetWords.length} · 额外词 ${saved.extraWords.length}`;
      const score = document.createElement("span");
      const value = saved.statistics.emotion.total;
      score.className = "saved-level-score";
      score.classList.toggle("is-positive", Number.isFinite(value) && value > 0);
      score.classList.toggle("is-negative", Number.isFinite(value) && value < 0);
      score.textContent = `情绪 ${Number.isFinite(value) ? value.toFixed(1) : "—"}`;
      button.setAttribute("aria-label", `${name.textContent}，${saved.rows} 行 ${saved.columns} 列，${meta.textContent}，${score.textContent}`);
      button.append(heading, meta);
      const footer = document.createElement("div");
      footer.className = "saved-level-footer";
      const controls = document.createElement("div");
      controls.className = "saved-level-controls";
      for (const [action, label, text] of [["up", "上移", "↑"], ["down", "下移", "↓"], ["delete", "删除", "删除"]]) {
        const control = document.createElement("button");
        control.type = "button";
        control.className = `saved-level-control saved-level-control--${action}`;
        control.dataset.levelAction = action;
        control.dataset.levelId = String(record.id);
        control.textContent = text;
        control.title = label;
        control.setAttribute("aria-label", `${label}${name.textContent}`);
        control.disabled = busy || (action === "up" && index === 0) || (action === "down" && index === savedLevels.length - 1);
        controls.append(control);
      }
      footer.append(score, controls);
      card.append(button, footer);
      fragment.append(card);
    }
    savedLevelList.replaceChildren(fragment);
    savedLevelList.scrollTop = scrollTop;
    savedLevelList.scrollLeft = scrollLeft;
  }

  function openSavedLevel(id) {
    if (batchRunning) return;
    const record = savedLevels.find(entry => entry.id === id);
    if (!record) return;
    stopGeneration();
    level = structuredClone(record.level);
    activeSavedLevelId = record.id;
    savedLevelEdited = false;
    selectedWord = null;
    size = { rows: level.rows, columns: level.columns };
    configuredTargetCount = level.targetCount;
    configuredTargetLengthPlan = isValidTargetPlan(level.targetCount, level.targetLengthPlan) && level.targetLengthPlan
      ? [...level.targetLengthPlan] : legacyTargetPlan(level.targetCount, level.targetLengthRatios, level.targetWords);
    configuredMaxWordLength = level.maxWordLength;
    configuredInitialMaxWordLength = level.initialMaxWordLength;
    configuredInitialForwardProbability = level.initialForwardProbability;
    configuredFilters = level.filters;
    configuredFixedWords = normalizeFixedWords(level.fixedWords ?? []);
    configuredFixedLayout = structuredClone(level.fixedLayout ?? null);
    configuredDuplicateRanges = Object.fromEntries(Object.keys(duplicateRangeInputs).map(kind =>
      [kind, level.duplicateCheck?.[kind]?.range ?? level.duplicateCheck?.range ?? configuredDuplicateRanges[kind]]));
    restoreTargetConfigInputs();
    maxWordLengthInput.value = String(configuredMaxWordLength);
    initialMaxWordLengthInput.value = String(configuredInitialMaxWordLength);
    initialForwardInput.value = String(configuredInitialForwardProbability);
    for (const [kind, input] of Object.entries(duplicateRangeInputs)) input.value = String(configuredDuplicateRanges[kind]);
    restoreFilterInputs();
    showPathSafetyWarning();
    wordList.parentElement.scrollTop = 0;
    render();
    savedLevelList.querySelector(`[data-saved-level-id="${record.id}"]`)?.focus({ preventScroll: true });
  }

  function makeLabels(amount) {
    const fragment = document.createDocumentFragment();
    for (let index = 1; index <= amount; index += 1) {
      const label = document.createElement("span");
      label.textContent = String(index).padStart(2, "0");
      fragment.append(label);
    }
    return fragment;
  }

  function isValidTargetCount(value) {
    return Number.isSafeInteger(value) && value >= 1;
  }

  function readTargetCount() {
    try {
      const saved = Number(localStorage.getItem(TARGET_STORAGE_KEY));
      if (isValidTargetCount(saved)) return saved;
    } catch {
      // Use the default when browser storage is unavailable.
    }
    return 6;
  }

  function isValidTargetPlan(targetCount, plan) {
    try {
      countTargetLengthPlan(targetCount, plan);
      return plan === null || (Array.isArray(plan) && plan.length <= MAX_TARGET_PLAN_SLOTS);
    } catch {
      return false;
    }
  }

  function legacyTargetPlan(targetCount, ratios, targetWords = []) {
    if (!ratios || targetCount > MAX_TARGET_PLAN_SLOTS) return null;
    try {
      const counts = allocateTargetLengths(targetCount, ratios);
      const actualPlan = targetWords.map(entry => targetLengthGroup(entry.word.length));
      if (isValidTargetPlan(targetCount, actualPlan)) {
        const actualCounts = countTargetLengthPlan(targetCount, actualPlan);
        if (Object.keys(counts).every(key => actualCounts[key] === counts[key])) return actualPlan;
      }
      return Object.entries(counts).flatMap(([group, amount]) => Array(amount).fill(group));
    } catch {
      return null;
    }
  }

  function readTargetLengthPlan() {
    try {
      const raw = localStorage.getItem(TARGET_PLAN_STORAGE_KEY);
      if (raw !== null) {
        const saved = JSON.parse(raw);
        return isValidTargetPlan(configuredTargetCount, saved) ? saved : null;
      }
      return legacyTargetPlan(configuredTargetCount, JSON.parse(localStorage.getItem(LEGACY_TARGET_RATIOS_STORAGE_KEY)));
    } catch {
      return null;
    }
  }

  function renderTargetPlanSummary() {
    const targetCount = targetInput.valueAsNumber;
    const counts = isValidTargetPlan(targetCount, draftTargetLengthPlan)
      ? countTargetLengthPlan(targetCount, draftTargetLengthPlan) : null;
    targetPlanSummary.textContent = counts ? `短词 ${counts.short} · 中词 ${counts.medium} · 长词 ${counts.long}` : "—";
  }

  function renderTargetConfigPreview() {
    const enabled = targetPlanEnabled.checked;
    targetPlanFields.hidden = !enabled;
    targetPlanSlots.replaceChildren();
    if (!enabled) return;
    const targetCount = targetInput.valueAsNumber;
    if (!isValidTargetCount(targetCount) || targetCount > MAX_TARGET_PLAN_SLOTS) {
      targetPlanSummary.textContent = "—";
      if (targetCount > MAX_TARGET_PLAN_SLOTS) {
        targetConfigError.textContent = `逐个配置最多支持 ${MAX_TARGET_PLAN_SLOTS} 个目标词。`;
        targetConfigError.hidden = false;
      }
      return;
    }
    draftTargetLengthPlan = Array.from({ length: targetCount }, (_, index) =>
      draftTargetLengthPlan[index] ?? Object.keys(TARGET_LENGTH_OPTIONS)[index % 3]);
    renderTargetPlanChoices(targetPlanSlots, draftTargetLengthPlan);
    renderTargetPlanSummary();
  }

  function restoreTargetConfigInputs() {
    targetInput.value = String(configuredTargetCount);
    targetPlanEnabled.checked = configuredTargetLengthPlan !== null;
    draftTargetLengthPlan = [...(configuredTargetLengthPlan ?? [])];
    targetConfigError.hidden = true;
    targetConfigError.textContent = "";
    renderTargetConfigPreview();
  }

  function isValidMaxWordLength(value) {
    return Number.isSafeInteger(value) && value >= 1;
  }

  function readMaxWordLength(storageKey = LENGTH_STORAGE_KEY, legacyKey) {
    try {
      for (const key of [storageKey, legacyKey].filter(Boolean)) {
        const saved = Number(localStorage.getItem(key));
        if (isValidMaxWordLength(saved)) return saved;
      }
    } catch {
      // Use the default when browser storage is unavailable.
    }
    return 8;
  }

  function isValidInitialForwardProbability(value) {
    return Number.isInteger(value) && value >= 0 && value <= 100;
  }

  function readInitialForwardProbability() {
    try {
      const saved = localStorage.getItem(FORWARD_STORAGE_KEY);
      if (saved !== null && saved.trim() !== "" && isValidInitialForwardProbability(Number(saved))) return Number(saved);
    } catch {
      // Use the default when browser storage is unavailable.
    }
    return 50;
  }

  function readFixedWords() {
    try { return normalizeFixedWords(JSON.parse(localStorage.getItem(FIXED_WORDS_STORAGE_KEY)) ?? []); }
    catch { return []; }
  }

  function readFixedLayout() {
    try {
      const saved = JSON.parse(localStorage.getItem(FIXED_LAYOUT_STORAGE_KEY));
      return saved ? normalizeFixedLayout({ rows: saved.rows, columns: saved.columns, fixedWords: configuredFixedWords, fixedLayout: saved }) : null;
    } catch { return null; }
  }

  function readFilters() {
    try {
      const saved = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
      const result = {};
      for (const [key, values] of Object.entries(saved)) {
        const options = filterOptions[key];
        if (!options || !Array.isArray(values) || values.some(value => !options.includes(value))) return {};
        const selected = [...new Set(values)].sort((a, b) => a - b);
        if (selected.length < options.length) result[key] = selected;
      }
      return result;
    } catch {
      return {};
    }
  }

  function isValidDuplicateRange(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function readDuplicateRange(storageKey) {
    try {
      for (const key of [storageKey, LEGACY_DUPLICATE_RANGE_STORAGE_KEY]) {
        const saved = localStorage.getItem(key);
        if (saved !== null && saved.trim() !== "" && isValidDuplicateRange(Number(saved))) return Number(saved);
      }
    } catch {
      // Keep a usable default when browser storage is unavailable.
    }
    return 20;
  }

  function filtersFromInputs() {
    const filters = {};
    for (const [key, options] of Object.entries(filterOptions)) {
      const selected = filterInputs.filter(input => input.dataset.wordFilter === key && input.checked)
        .map(input => Number(input.value));
      if (selected.length < options.length) filters[key] = selected;
    }
    return filters;
  }

  function restoreFilterInputs() {
    for (const input of filterInputs) {
      const selected = configuredFilters[input.dataset.wordFilter];
      input.checked = selected === undefined || selected.includes(Number(input.value));
    }
  }

  function svgElement(name, attributes) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function createPathPreview(entry) {
    const path = entry.path ?? [];
    const score = entry.pathAnalysis.assigned.difficultyScore;
    const preview = svgElement("svg", {
      class: "word-path-preview",
      "data-score-band": Math.min(3, score),
      viewBox: `0 0 ${size.columns * 12 + 4} ${size.rows * 12 + 4}`,
      "aria-hidden": "true",
      focusable: "false",
    });
    const title = svgElement("title", {});
    title.textContent = `${entry.word} 的连接路径，难度 ${score} 分`;
    preview.append(title);
    for (let index = 0; index < size.rows * size.columns; index += 1) {
      preview.append(svgElement("rect", {
        class: "mini-cell",
        x: 3 + (index % size.columns) * 12,
        y: 3 + Math.floor(index / size.columns) * 12,
        width: 10,
        height: 10,
        rx: 1.5,
      }));
    }
    const points = path.map(index => ({ x: 8 + (index % size.columns) * 12, y: 8 + Math.floor(index / size.columns) * 12 }));
    if (points.length) {
      const line = svgElement("polyline", {
        class: "mini-path-line",
        points: points.map(point => `${point.x},${point.y}`).join(" "),
      });
      preview.append(line);
      if (points.length > 1) {
        const start = points.at(-2);
        const end = points.at(-1);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const base = { x: end.x - dx * .5, y: end.y - dy * .5 };
        line.setAttribute("points", [...points.slice(0, -1), base].map(point => `${point.x},${point.y}`).join(" "));
        const sideX = -dy / 12 * 3.5;
        const sideY = dx / 12 * 3.5;
        preview.append(svgElement("polygon", {
          class: "mini-path-arrow",
          points: `${end.x},${end.y} ${base.x + sideX},${base.y + sideY} ${base.x - sideX},${base.y - sideY}`,
        }));
      }
    }
    const cell = document.createElement("span");
    cell.className = "word-path-cell";
    cell.dataset.column = "path";
    cell.append(preview);
    return cell;
  }

  function renderWords() {
    const scrollTop = wordList.parentElement.scrollTop;
    const checkPath = createPathSafetyChecker(level);
    const roles = [
      { key: "initial", label: "初始词", words: new Set(level?.initialWords.map(entry => entry.word) ?? []) },
      { key: "candidate", label: "候选词", words: new Set(level?.candidateWords.filter(entry => checkPath(entry.word)).map(entry => entry.word) ?? []) },
      { key: "target", label: "关卡目标", words: new Set(level?.targetWords.map(entry => entry.word) ?? []) },
      { key: "extra", label: "额外词", words: new Set(level?.extraWords.map(entry => entry.word) ?? []) },
    ];
    const byWord = new Map();
    for (const entry of [...(level?.initialWords ?? []), ...(level?.targetWords ?? []),
      ...(level?.candidateWords ?? []), ...(level?.extraWords ?? [])]) {
      if (!byWord.has(entry.word)) byWord.set(entry.word, entry);
    }
    const membership = Object.fromEntries(roles.map(role => [role.key, role.words]));
    const tagColumns = [...roles.filter(role => role.key !== "target" && role.key !== "extra"),
      { key: "only-extra", label: "仅额外" }];
    const priority = entry => {
      if (membership.initial.has(entry.word)) return 0;
      if (membership.target.has(entry.word)) return 1;
      if (entry.onlyExtra) return 4;
      if (membership.extra.has(entry.word)) return 2;
      if (membership.candidate.has(entry.word)) return 3;
      return 5;
    };
    const entries = [...byWord.values()].sort((a, b) => priority(a) - priority(b) || a.word.localeCompare(b.word));
    wordCount.textContent = String(entries.length);
    targetWordCount.textContent = String(membership.target.size);
    extraWordCount.textContent = String(membership.extra.size);
    const buttons = document.createDocumentFragment();
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "word-row";
      row.classList.toggle("is-target", membership.target.has(entry.word));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "word-button";
      button.classList.toggle("is-target", membership.target.has(entry.word));
      button.dataset.word = entry.word;
      button.dataset.onlyExtra = String(entry.onlyExtra);
      for (const key of Object.keys(filterOptions)) button.dataset[key] = String(entry[key] ?? "");
      button.setAttribute("aria-pressed", String(entry.word === selectedWord));
      const text = document.createElement("span");
      text.className = "word-text";
      text.textContent = entry.word;
      const definition = [entry.definitionZh, entry.definitionEn]
        .find(value => typeof value === "string" && value.trim())?.trim() ?? "暂无释义";
      text.title = definition;
      button.setAttribute("aria-description", definition);
      const rarity = document.createElement("span");
      rarity.className = "word-value-cell";
      rarity.dataset.column = "rarity";
      rarity.textContent = String(entry.rarityLevel ?? "—");
      const assigned = entry.pathAnalysis.assigned;
      const pathScore = document.createElement("span");
      pathScore.className = "word-value-cell";
      pathScore.dataset.column = "path-score";
      pathScore.textContent = String(assigned.difficultyScore);
      pathScore.title = `首向 ${assigned.directionScore} 分 + 拐点 ${assigned.turns} 分 + 折返 ${assigned.reversals} 分`;
      button.append(text, rarity, createPathPreview(entry), pathScore);
      const tags = roles.filter(role => role.words.has(entry.word));
      if (entry.onlyExtra) tags.push({ key: "only-extra", label: "仅额外" });
      for (const { key, label } of tagColumns) {
        const cell = document.createElement("span");
        cell.className = "word-label-cell";
        cell.dataset.column = key;
        if (tags.some(tag => tag.key === key)) {
          const tag = document.createElement("span");
          tag.className = `word-tag word-tag--${key}`;
          tag.dataset.kind = key;
          tag.textContent = label;
          cell.append(tag);
        }
        button.append(cell);
      }
      button.setAttribute("aria-label", `${entry.word}，生僻档位 ${rarity.textContent}，路径难度 ${assigned.difficultyScore} 分，${tags.map(tag => tag.label).join("、")}`);
      const selection = document.createElement("label");
      selection.className = "target-selection";
      if ((membership.candidate.has(entry.word) || membership.target.has(entry.word)) && !entry.onlyExtra) {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.targetWord = entry.word;
        checkbox.checked = membership.target.has(entry.word);
        checkbox.disabled = membership.initial.has(entry.word) || generating || savingLevel || updatingLevelList || batchRunning;
        checkbox.setAttribute("aria-label", `${entry.word} 设为目标词`);
        selection.title = membership.initial.has(entry.word) ? "初始词不能移除" : checkbox.checked ? "移出目标词" : "加入目标词";
        selection.append(checkbox);
      } else {
        selection.textContent = "—";
        selection.title = !checkPath(entry.word) ? "存在使用不同格子的连接路径，不能设为目标词" : "只有候选词可选为目标词";
      }
      row.append(button, selection);
      buttons.append(row);
    }
    wordList.replaceChildren(buttons);
    wordList.parentElement.scrollTop = scrollTop;
  }

  function formatEmotionScore() {
    const score = level?.statistics.emotion.total;
    return Number.isFinite(score) ? score.toFixed(1) : "—";
  }

  function renderStatistics() {
    const stats = level?.statistics;
    levelDataButton.disabled = !stats;
    if (displayedStatistics === stats) return;
    displayedStatistics = stats;
    levelDataContent.replaceChildren();
    levelDataContent.scrollTop = 0;
    if (!stats) {
      if (levelDataPanel.matches(":popover-open")) levelDataPanel.hidePopover();
      return;
    }
    const number = (value, decimals = 0) => Number.isFinite(value) ? value.toFixed(decimals) : "—";
    const share = (count, ratio, unit = "词") => `${count} ${unit} · ${number(ratio * 100, 1)}%`;
    const distribution = (values, suffix) => Object.entries(values).map(([key, value]) => `${key}${suffix} ${value}`).join(" / ");
    const groups = document.createElement("div");
    groups.className = "stat-groups";
    const { vocabulary, workload, lengths, paths, board: boardStats, usage, words, emotion } = stats;
    const directions = { R: "右", D: "下", L: "左", U: "上", none: "无" };
    const sections = [
      ["词量与词长（目标词）", [
        ["目标词数", workload.targetCount], ["目标字母总数", workload.totalLetters],
        ["最长词", `${lengths.longest} 字母`], ["词长分布", distribution(lengths.distribution, "字母")],
        ["5 字母及以上", share(lengths.fivePlusCount, lengths.fivePlusRatio)],
        ["7 字母及以上", share(lengths.sevenPlusCount, lengths.sevenPlusRatio)],
      ]],
      ["路径（目标词 · 代表路径）", [
        ["首向分布", Object.entries(paths.firstDirectionDistribution).map(([key, value]) => `${directions[key]} ${value}`).join(" / ")],
        ["拐点分布", distribution(paths.turnDistribution, "拐")],
        ["平均拐点", number(paths.averageTurns, 2)],
        ["直线词", share(paths.straightCount, paths.straightRatio)],
        ["向右直线词", share(paths.rightStraightCount, paths.rightStraightRatio)],
        ["向下直线词", share(paths.downStraightCount, paths.downStraightRatio)],
        ["折返词", share(paths.reversalWordCount, paths.reversalWordRatio)],
        ["折返总次数", paths.totalReversals], ["多路径目标词", paths.multiplePathWordCount],
      ], "最少拐 → 最少折返 → 首向右、下、左、上 → 坐标序列"],
      ["词汇（目标词）", [
        ["生僻档位分布", distribution(vocabulary.rarityDistribution, "档")],
        ["生僻总分", number(calculateRarityTotal(level.targetWords))],
        ["档位缺失", vocabulary.unknownRarityCount],
      ]],
      ["棋盘", [
        ["尺寸", `${boardStats.rows} × ${boardStats.columns} · ${boardStats.cellCount} 格`],
        ["不同字母数", boardStats.distinctLetterCount],
        ["字母格数", distribution(boardStats.letterDistribution, "")],
        ["重复字母格", share(boardStats.duplicateLetterCellCount, boardStats.duplicateLetterCellRatio, "格"), "每种字母保留首个格子，其余重复格数 ÷ 总格数"],
      ]],
      ["格子使用（实际路径）", [
        ["平均使用密度", number(usage.density, 2), "目标字母总数 ÷ 棋盘格数"],
        ["单格最多使用", `${usage.maximum} 次`],
        ["次数分布", distribution(usage.distribution, "次")],
      ]],
      ["候选与额外", [
        ["可连接单词总数", words.total], ["可作目标的候选词", words.eligibleCandidateCount],
        ["目标词", share(words.targetCount, words.targetRatio)],
        ["额外词", share(words.extraCount, words.extraRatio)], ["其中仅额外", words.onlyExtraCount],
      ]],
      ["情绪", [
        ["目标词情绪和 × 1", number(emotion.targetSum)],
        ["额外词情绪和 × 0.3", number(emotion.extraSum === null ? null : emotion.extraSum * 0.3, 1)],
        ["情绪总分", number(emotion.total, 1)],
      ]],
    ];
    for (const [heading, rows, description] of sections) {
      const section = document.createElement("section");
      section.className = "stat-group";
      const title = document.createElement("h3");
      title.textContent = heading;
      if (description) title.title = description;
      const list = document.createElement("dl");
      for (const [label, value, hint] of rows) {
        const row = document.createElement("div");
        const term = document.createElement("dt");
        term.textContent = label;
        if (hint) term.title = hint;
        const detail = document.createElement("dd");
        detail.textContent = value;
        row.append(term, detail);
        list.append(row);
      }
      section.append(title, list);
      groups.append(section);
    }
    const table = document.createElement("table");
    table.className = "path-stat-table";
    const caption = table.createCaption();
    caption.textContent = "目标词路径（代表路径）";
    caption.title = "最少拐 → 最少折返 → 首向右、下、左、上 → 坐标序列";
    const head = table.createTHead().insertRow();
    for (const label of ["单词", "合法路径数", "首向", "拐点", "折返", "路径分"]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      head.append(cell);
    }
    const body = table.createTBody();
    for (const entry of level.targetWords) {
      const row = body.insertRow();
      row.dataset.word = entry.word;
      const { legalPathCount, representative } = entry.pathAnalysis;
      for (const value of [entry.word, legalPathCount, directions[representative.firstDirection ?? "none"], representative.turns, representative.reversals, representative.difficultyScore]) {
        row.insertCell().textContent = value;
      }
    }
    levelDataContent.append(groups, table);
  }

  function fitBoard() {
    const stageStyle = getComputedStyle(boardStage);
    const layoutStyle = getComputedStyle(layout);
    const width = boardStage.clientWidth - parseFloat(stageStyle.paddingLeft) - parseFloat(stageStyle.paddingRight);
    const height = boardStage.clientHeight - parseFloat(stageStyle.paddingTop) - parseFloat(stageStyle.paddingBottom);
    const metric = name => parseFloat(layoutStyle.getPropertyValue(name));
    const gap = metric("--cell-gap");
    const horizontalSize = (width - metric("--axis-width") - metric("--axis-gap") - (size.columns - 1) * gap) / size.columns;
    const verticalSize = (height - metric("--axis-height") - metric("--axis-gap") - (size.rows - 1) * gap) / size.rows;
    const cellSize = Math.max(0, Math.floor(Math.min(104, horizontalSize, verticalSize)));
    layout.style.setProperty("--cell-size", `${cellSize}px`);
    layout.classList.toggle("compact-cells", cellSize < 40);
  }

  function renderGenerationButton() {
    generateButton.disabled = batchRunning || (!generating && (savingLevel || updatingLevelList || (Object.values(configuredDuplicateRanges).some(range => range > 0) && !levelLibraryReady)));
    generateButton.setAttribute("aria-busy", String(generating));
    generateButton.textContent = generating ? "停止生成" : level ? "重新生成" : "生成关卡";
    generateButton.title = generating
      ? `${generationWorkers} 路并行 · ${generationAttempts ? `已尝试 ${generationAttempts} 次` : "正在生成符合配置的关卡"}；点击停止`
      : "";
  }

  function render() {
    const { rows, columns } = size;
    layout.style.setProperty("--rows", rows);
    layout.style.setProperty("--columns", columns);
    rowLabels.replaceChildren(makeLabels(rows));
    columnLabels.replaceChildren(makeLabels(columns));

    const selected = [...(level?.targetWords ?? []), ...(level?.extraWords ?? [])].find(entry => entry.word === selectedWord);
    const steps = new Map(selected?.path.map((cell, index) => [cell, index + 1]) ?? []);

    const fragment = document.createDocumentFragment();
    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      const row = document.createElement("div");
      row.className = "board-row";
      row.setAttribute("role", "row");
      for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
        const index = rowIndex * columns + columnIndex;
        const value = level?.cells[index] ?? { letter: "", count: 0 };
        const cell = document.createElement("div");
        cell.className = `board-cell${(rowIndex + columnIndex) % 2 === 1 ? " alternate" : ""}`;
        cell.classList.toggle("path-selected", steps.has(index));
        cell.setAttribute("role", "cell");
        cell.setAttribute("aria-label", `第 ${rowIndex + 1} 行，第 ${columnIndex + 1} 列，${value.letter || "空白"}，${value.count} 个目标词使用${steps.has(index) ? `，路径第 ${steps.get(index)} 步` : ""}`);
        cell.dataset.row = String(rowIndex + 1);
        cell.dataset.column = String(columnIndex + 1);
        const letter = document.createElement("span");
        letter.className = "cell-letter";
        letter.textContent = value.letter;
        const usage = document.createElement("span");
        usage.className = `cell-usage${value.count > 1 ? " shared" : ""}`;
        usage.textContent = String(value.count);
        cell.append(letter, usage);
        if (steps.has(index)) {
          const step = document.createElement("span");
          step.className = "cell-path-order";
          step.textContent = String(steps.get(index));
          cell.append(step);
        }
        row.append(cell);
      }
      fragment.append(row);
    }
    board.replaceChildren(fragment);
    board.setAttribute("aria-rowcount", String(rows));
    board.setAttribute("aria-colcount", String(columns));
    board.setAttribute("aria-label", `${level ? "关卡棋盘" : "空白棋盘"}，${rows} 行 ${columns} 列`);

    form.elements.namedItem("rows").value = String(rows);
    form.elements.namedItem("columns").value = String(columns);
    summary.textContent = `${rows} 行 × ${columns} 列`;
    count.textContent = String(rows * columns);
    targetConfigSummary.textContent = `${configuredTargetCount} 词`;
    targetConfigButton.classList.toggle("is-active", configuredTargetLengthPlan !== null);
    const targetLengthCounts = countTargetLengthPlan(configuredTargetCount, configuredTargetLengthPlan);
    targetConfigButton.title = targetLengthCounts
      ? `短词 ${targetLengthCounts.short} · 中词 ${targetLengthCounts.medium} · 长词 ${targetLengthCounts.long}` : "仅配置数量";
    emotionScore.textContent = formatEmotionScore();
    const rarityTotal = level ? calculateRarityTotal(level.targetWords) : null;
    rarityScore.textContent = Number.isFinite(rarityTotal) ? String(rarityTotal) : "—";
    const emotionTotal = level?.statistics.emotion.total;
    emotionScore.classList.toggle("is-positive", Number.isFinite(emotionTotal) && emotionTotal > 0);
    emotionScore.classList.toggle("is-negative", Number.isFinite(emotionTotal) && emotionTotal < 0);
    resetButton.disabled = rows === DEFAULT_SIZE.rows && columns === DEFAULT_SIZE.columns;
    renderGenerationButton();
    const activeFilters = Object.keys(configuredFilters).length;
    filterSummary.textContent = activeFilters ? `${activeFilters}项` : "全部";
    filterButton.classList.toggle("is-active", activeFilters > 0);
    activeFixedWords.hidden = configuredFixedWords.length === 0;
    fixedWordsSummary.textContent = configuredFixedWords.join(" · ");
    const pinnedCount = configuredFixedLayout?.placements.length ?? 0;
    activeFixedWords.title = configuredFixedWords.join(", ") + `（固定位置 ${pinnedCount} 词，自动摆放 ${configuredFixedWords.length - pinnedCount} 词）`;
    renderWords();
    renderStatistics();
    renderSavedLevels();
    form.inert = batchRunning;
    saveSize();
    fitBoard();
  }

  function stopGeneration() {
    requestId += 1;
    generationController?.abort();
    generationController = null;
    generating = false;
    generationAttempts = 0;
    generationWorkers = 0;
  }

  function clearLevel() {
    stopGeneration();
    level = null;
    activeSavedLevelId = null;
    savedLevelEdited = false;
    selectedWord = null;
    errorMessage.hidden = true;
    errorMessage.textContent = "";
  }

  function showPathSafetyWarning() {
    const checkPath = createPathSafetyChecker(level);
    const unsafeTargets = level?.targetWords.filter(entry => !checkPath(entry.word)).map(entry => entry.word) ?? [];
    errorMessage.hidden = unsafeTargets.length === 0;
    errorMessage.textContent = unsafeTargets.length ? `目标词 ${unsafeTargets.join("、")} 存在使用不同格子的连接路径，请重新生成或调整目标词；修复前不能导出。` : "";
  }

  function showError(message) {
    generating = false;
    errorMessage.textContent = message;
    errorMessage.hidden = false;
    render();
  }

  function getGenerationClient() {
    const workerCount = defaultGenerationWorkers();
    if (generationClient?.workerCount !== workerCount) {
      generationClient?.close();
      generationClient = createGenerationClient({ workerCount });
    }
    return generationClient;
  }

  generateButton.addEventListener("click", async () => {
    if (batchRunning) return;
    batchRunBar.hidden = true;
    if (generating) {
      stopGeneration();
      render();
      return;
    }
    const targetCount = configuredTargetCount;
    const targetLengthPlan = configuredTargetLengthPlan;
    const initialMaxWordLength = initialMaxWordLengthInput.valueAsNumber;
    if (!isValidMaxWordLength(initialMaxWordLength)) {
      showError("初始词最长需为大于 0 的整数。");
      initialMaxWordLengthInput.focus();
      return;
    }
    const maxWordLength = maxWordLengthInput.valueAsNumber;
    if (!isValidMaxWordLength(maxWordLength)) {
      showError("最长单词长度需为大于 0 的整数。");
      maxWordLengthInput.focus();
      return;
    }
    const initialForwardProbability = initialForwardInput.valueAsNumber;
    if (!isValidInitialForwardProbability(initialForwardProbability)) {
      showError("初始正向概率需为 0–100 的整数。");
      initialForwardInput.focus();
      return;
    }
    const duplicateRanges = {};
    for (const [kind, input] of Object.entries(duplicateRangeInputs)) {
      if (!isValidDuplicateRange(input.valueAsNumber)) {
        showError(`${kind === "target" ? "目标词" : "额外词"}查重范围需为大于或等于 0 的整数。`);
        input.focus();
        return;
      }
      duplicateRanges[kind] = input.valueAsNumber;
    }
    if (Object.values(duplicateRanges).some(range => range > 0) && !levelLibraryReady) {
      showError("请等待关卡列表加载完成后再查重生成。");
      return;
    }
    const filters = filtersFromInputs();
    if (configuredTargetCount !== targetCount || configuredMaxWordLength !== maxWordLength || configuredInitialMaxWordLength !== initialMaxWordLength ||
      configuredInitialForwardProbability !== initialForwardProbability || JSON.stringify(configuredFilters) !== JSON.stringify(filters)) clearLevel();
    configuredTargetCount = targetCount;
    configuredMaxWordLength = maxWordLength;
    configuredInitialMaxWordLength = initialMaxWordLength;
    configuredInitialForwardProbability = initialForwardProbability;
    configuredDuplicateRanges = duplicateRanges;
    configuredFilters = filters;
    if (location.protocol === "file:") {
      showError("请通过本地服务打开编辑器。");
      return;
    }
    errorMessage.hidden = true;
    errorMessage.textContent = "";
    generating = true;
    generationAttempts = 0;
    generationWorkers = defaultGenerationWorkers();
    const currentRequestId = ++requestId;
    const controller = new AbortController();
    generationController = controller;
    render();
    try {
      const duplicateCheck = createDuplicateCheck(savedLevels, configuredDuplicateRanges);
      const generated = await getGenerationClient().generate({ ...size, targetCount, targetLengthPlan,
        initialMaxWordLength, maxWordLength, initialForwardProbability, filters, fixedWords: configuredFixedWords, fixedLayout: configuredFixedLayout }, duplicateCheck, {
        signal: controller.signal,
        onProgress: ({ attempts, workers }) => {
          if (currentRequestId !== requestId || controller.signal.aborted) return;
          generationAttempts = attempts;
          generationWorkers = workers;
          renderGenerationButton();
        },
      });
      if (currentRequestId !== requestId || controller.signal.aborted || !generated) return;
      generating = false;
      level = generated;
      activeSavedLevelId = null;
      savedLevelEdited = false;
      selectedWord = null;
      for (const scroller of document.querySelectorAll(".word-scroll")) scroller.scrollTop = 0;
      render();
    } catch (error) {
      if (currentRequestId === requestId && !controller.signal.aborted) showError(error.message || "生成失败，请重试。");
    } finally {
      if (generationController === controller) generationController = null;
    }
  });

  addLevelButton.addEventListener("click", async () => {
    if (!level || generating || savingLevel || updatingLevelList || batchRunning || !levelLibraryReady || (activeSavedLevelId !== null && !savedLevelEdited)) return;
    const source = level;
    const existingRecord = savedLevels.find(record => record.id === activeSavedLevelId) ?? null;
    if (!existingRecord) {
      const duplicates = findDuplicateWords(source, createDuplicateCheck(savedLevels, configuredDuplicateRanges));
      if (duplicates.target.length || duplicates.extra.length) {
        savedLevelError.textContent = Object.entries(duplicates).filter(([, words]) => words.length)
          .map(([kind, words]) => `${kind === "target" ? "目标词" : "额外词"}与最近 ${configuredDuplicateRanges[kind]} 关重复：${words.join("、")}`)
          .join("；") + "。请重新生成。";
        savedLevelError.hidden = false;
        return;
      }
    }
    const snapshot = structuredClone(source);
    savingLevel = true;
    savedLevelError.hidden = true;
    savedLevelError.textContent = "";
    renderSavedLevels();
    renderGenerationButton();
    renderWords();
    try {
      const store = await getLevelStore();
      const record = await store.saveLevel(snapshot, existingRecord);
      savedLevels = existingRecord ? savedLevels.map(entry => entry.id === record.id ? record : entry) : [...savedLevels, record];
      savedLevelListDirty = true;
      if (level === source) {
        activeSavedLevelId = record.id;
        savedLevelEdited = false;
      }
    } catch (error) {
      savedLevelError.textContent = error.name === "QuotaExceededError"
        ? "本地存储空间不足，未能保存关卡。" : "关卡保存失败，请重试。";
      savedLevelError.hidden = false;
    } finally {
      savingLevel = false;
      renderSavedLevels();
      renderGenerationButton();
      renderWords();
      if (level === source && activeSavedLevelId !== null) {
        savedLevelList.querySelector(`[data-saved-level-id="${activeSavedLevelId}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }
  });

  exportLevelsButton.addEventListener("click", async () => {
    if (exportLevelsButton.disabled) return;
    exportingLevels = true;
    savedLevelError.hidden = true;
    renderSavedLevels();
    try {
      const records = await (await getLevelStore()).getSavedLevels();
      const text = gameExportText(records);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "word-tiles-levels.json";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      savedLevelError.textContent = `导出失败：${error.message || "无法读取关卡列表。"}`;
      savedLevelError.hidden = false;
    } finally {
      exportingLevels = false;
      renderSavedLevels();
    }
  });

  importLevelsButton.addEventListener("click", () => {
    if (!importLevelsButton.disabled) importLevelsFile.click();
  });
  importLevelsFile.addEventListener("change", async () => {
    const file = importLevelsFile.files[0];
    importLevelsFile.value = "";
    if (!file || importLevelsButton.disabled) return;
    updatingLevelList = true;
    savedLevelError.hidden = true;
    render();
    let worker;
    try {
      const text = await file.text();
      const levels = await new Promise((resolve, reject) => {
        worker = new Worker("./import-worker.js", { type: "module" });
        worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.levels);
        worker.onerror = () => reject(new Error("关卡读取失败，请刷新重试。"));
        worker.postMessage(text);
      });
      const previousCount = savedLevels.length;
      savedLevels = await (await getLevelStore()).importSavedLevels(levels);
      savedLevelListDirty = true;
      openSavedLevel(savedLevels[previousCount].id);
    } catch (error) {
      savedLevelError.textContent = `导入失败：${error.message || "无法保存关卡。"}`;
      savedLevelError.hidden = false;
    } finally {
      worker?.terminate();
      updatingLevelList = false;
      render();
    }
  });

  savedLevelList.addEventListener("click", async event => {
    const control = event.target.closest("button[data-level-action]");
    if (control) {
      if (generating || savingLevel || updatingLevelList || batchRunning || control.disabled || !levelLibraryReady) return;
      const id = Number(control.dataset.levelId);
      const action = control.dataset.levelAction;
      const index = savedLevels.findIndex(record => record.id === id);
      if (index < 0) return;
      updatingLevelList = true;
      savedLevelError.hidden = true;
      savedLevelError.textContent = "";
      render();
      try {
        const store = await getLevelStore();
        savedLevels = action === "delete" ? await store.deleteSavedLevel(id) : await store.moveSavedLevel(id, action === "up" ? -1 : 1);
        if (action === "delete" && activeSavedLevelId === id) {
          activeSavedLevelId = null;
          savedLevelEdited = false;
        }
        savedLevelListDirty = true;
      } catch {
        savedLevelError.textContent = action === "delete" ? "关卡删除失败，请重试。" : "关卡顺序保存失败，请重试。";
        savedLevelError.hidden = false;
      } finally {
        updatingLevelList = false;
        render();
        const nextId = savedLevels.some(record => record.id === id) ? id : savedLevels[Math.min(index, savedLevels.length - 1)]?.id;
        const nextControl = savedLevelList.querySelector(`[data-level-action="${action}"][data-level-id="${nextId}"]`);
        const focusTarget = nextControl && !nextControl.disabled ? nextControl : savedLevelList.querySelector(`[data-saved-level-id="${nextId}"]`);
        focusTarget?.focus({ preventScroll: true });
        focusTarget?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      return;
    }
    if (updatingLevelList || batchRunning) return;
    const button = event.target.closest("button[data-saved-level-id]");
    if (button) openSavedLevel(Number(button.dataset.savedLevelId));
  });

  wordList.addEventListener("change", event => {
    const checkbox = event.target.closest("input[data-target-word]");
    if (!checkbox || !level || generating || savingLevel || updatingLevelList || batchRunning) return;
    try {
      level = setTargetWord(level, checkbox.dataset.targetWord, checkbox.checked);
      if (activeSavedLevelId !== null) savedLevelEdited = true;
      showPathSafetyWarning();
      render();
    } catch (error) {
      showError(error.message);
    }
    wordList.querySelector(`input[data-target-word="${checkbox.dataset.targetWord}"]`)?.focus({ preventScroll: true });
  });

  document.querySelector(".editor").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-word]");
    if (!button) return;
    selectedWord = selectedWord === button.dataset.word ? null : button.dataset.word;
    render();
    [...wordList.querySelectorAll("button")].find(item => item.dataset.word === button.dataset.word)?.focus({ preventScroll: true });
  });

  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("change", (event) => {
    if (targetConfigPanel.contains(event.target)) return;
    const duplicateKind = Object.keys(duplicateRangeInputs).find(kind => event.target === duplicateRangeInputs[kind]);
    if (duplicateKind) {
      clearLevel();
      if (!isValidDuplicateRange(event.target.valueAsNumber)) {
        showError(`${duplicateKind === "target" ? "目标词" : "额外词"}查重范围需为大于或等于 0 的整数。`);
        return;
      }
      configuredDuplicateRanges[duplicateKind] = event.target.valueAsNumber;
      render();
      return;
    }
    if (filterInputs.includes(event.target)) {
      clearLevel();
      configuredFilters = filtersFromInputs();
      render();
      return;
    }
    if (event.target === initialMaxWordLengthInput) {
      clearLevel();
      const initialMaxWordLength = initialMaxWordLengthInput.valueAsNumber;
      if (!isValidMaxWordLength(initialMaxWordLength)) {
        showError("初始词最长需为大于 0 的整数。");
        return;
      }
      configuredInitialMaxWordLength = initialMaxWordLength;
      render();
      return;
    }
    if (event.target === maxWordLengthInput) {
      clearLevel();
      const maxWordLength = maxWordLengthInput.valueAsNumber;
      if (!isValidMaxWordLength(maxWordLength)) {
        showError("最长单词长度需为大于 0 的整数。");
        return;
      }
      configuredMaxWordLength = maxWordLength;
      render();
      return;
    }
    if (event.target === initialForwardInput) {
      clearLevel();
      const initialForwardProbability = initialForwardInput.valueAsNumber;
      if (!isValidInitialForwardProbability(initialForwardProbability)) {
        showError("初始正向概率需为 0–100 的整数。");
        return;
      }
      configuredInitialForwardProbability = initialForwardProbability;
      render();
      return;
    }
    if (!(event.target instanceof HTMLInputElement) || !(event.target.name in LIMITS)) return;
    const nextSize = { ...size, [event.target.name]: Number(event.target.value) };
    if (!isValidSize(nextSize)) return;
    size = nextSize;
    clearLevel();
    render();
  });

  resetButton.addEventListener("click", () => {
    size = { ...DEFAULT_SIZE };
    clearLevel();
    render();
  });

  document.querySelector("#reset-filters").addEventListener("click", () => {
    configuredFilters = {};
    restoreFilterInputs();
    clearLevel();
    render();
  });

  targetConfigPanel.addEventListener("beforetoggle", (event) => {
    if (event.newState === "open") restoreTargetConfigInputs();
  });
  targetConfigPanel.addEventListener("input", event => {
    targetConfigError.hidden = true;
    if (event.target.matches("input[type='radio'][data-target-index]") && event.target.checked) {
      draftTargetLengthPlan[Number(event.target.dataset.targetIndex)] = event.target.value;
      renderTargetPlanSummary();
    } else {
      renderTargetConfigPreview();
    }
  });
  document.querySelector("#apply-target-config").addEventListener("click", () => {
    const targetCount = targetInput.valueAsNumber;
    const plan = targetPlanEnabled.checked ? [...draftTargetLengthPlan] : null;
    if (!isValidTargetCount(targetCount) || !isValidTargetPlan(targetCount, plan)) {
      targetConfigError.textContent = !isValidTargetCount(targetCount)
        ? "目标数量需为大于 0 的整数。" : targetCount > MAX_TARGET_PLAN_SLOTS
          ? `逐个配置最多支持 ${MAX_TARGET_PLAN_SLOTS} 个目标词。` : "请为每个目标词选择短词、中词或长词。";
      targetConfigError.hidden = false;
      targetInput.focus();
      return;
    }
    if (configuredTargetCount !== targetCount || JSON.stringify(configuredTargetLengthPlan) !== JSON.stringify(plan)) {
      configuredTargetCount = targetCount;
      configuredTargetLengthPlan = plan;
      clearLevel();
      render();
    }
    targetConfigPanel.hidePopover();
  });

  function applyEditorConfig(config) {
    size = { rows: config.rows, columns: config.columns };
    configuredTargetCount = config.targetCount;
    configuredTargetLengthPlan = config.targetLengthPlan;
    configuredInitialMaxWordLength = config.initialMaxWordLength;
    configuredMaxWordLength = config.maxWordLength;
    configuredInitialForwardProbability = config.initialForwardProbability;
    configuredDuplicateRanges = { target: config.targetDuplicateRange, extra: config.extraDuplicateRange };
    configuredFilters = config.filters;
    configuredFixedWords = normalizeFixedWords(config.fixedWords ?? []);
    configuredFixedLayout = structuredClone(config.fixedLayout ?? null);
    restoreTargetConfigInputs();
    initialMaxWordLengthInput.value = String(configuredInitialMaxWordLength);
    maxWordLengthInput.value = String(configuredMaxWordLength);
    initialForwardInput.value = String(configuredInitialForwardProbability);
    for (const [kind, input] of Object.entries(duplicateRangeInputs)) input.value = String(configuredDuplicateRanges[kind]);
    restoreFilterInputs();
  }

  async function runConfigList(jobs, onUpdate) {
    if (batchRunning || savingLevel || updatingLevelList) throw new Error("请等待当前保存或运行完成。");
    if (!levelLibraryReady) throw new Error("关卡列表尚未加载完成，暂时不能批量生成。");
    stopGeneration();
    generationClient?.close();
    generationClient = null;
    batchRunning = true;
    savedLevelListDirty = true;
    errorMessage.hidden = true;
    savedLevelError.hidden = true;
    render();
    const client = createGenerationClient();
    batchRunner = createBatchRunner({
      getHistory: async () => {
        const store = await getLevelStore();
        savedLevels = await store.getSavedLevels();
        savedLevelListDirty = true;
        renderSavedLevels();
        return savedLevels;
      },
      generate: (...args) => client.generate(...args),
      save: async generated => {
        try { return await (await getLevelStore()).saveLevel(generated); }
        catch (error) { throw new Error(error.name === "QuotaExceededError" ? "本地存储空间不足，本关未保存。" : "关卡保存失败，请重试。"); }
      },
      onSaved: (record, job) => {
        savedLevels = [...savedLevels, record];
        savedLevelListDirty = true;
        level = structuredClone(record.level);
        activeSavedLevelId = record.id;
        savedLevelEdited = false;
        selectedWord = null;
        applyEditorConfig(job.config);
        wordList.parentElement.scrollTop = 0;
        render();
      },
      onUpdate: state => {
        batchRunBar.hidden = false;
        batchRunStatus.textContent = formatBatchState(state);
        batchRunStatus.classList.toggle("is-error", state.phase === "error");
        batchRunProgress.max = state.total;
        batchRunProgress.value = state.completed;
        stopBatchButton.disabled = ["stopping", "stopped", "complete", "error"].includes(state.phase);
        onUpdate(state);
      },
    });
    try { return await batchRunner.run(jobs); }
    finally {
      client.close();
      batchRunner = null;
      batchRunning = false;
      savedLevelListDirty = true;
      stopBatchButton.disabled = true;
      render();
    }
  }

  stopBatchButton.addEventListener("click", () => batchRunner?.stop());

  setupConfigList({
    getConfig: () => structuredClone({
      ...size, targetCount: configuredTargetCount, targetLengthPlan: configuredTargetLengthPlan,
      initialMaxWordLength: configuredInitialMaxWordLength, maxWordLength: configuredMaxWordLength,
      initialForwardProbability: configuredInitialForwardProbability, filters: configuredFilters, fixedWords: configuredFixedWords, fixedLayout: configuredFixedLayout,
      initialRarityLevel: 1, minimumEmotionScore: 0,
      targetDuplicateRange: configuredDuplicateRanges.target, extraDuplicateRange: configuredDuplicateRanges.extra,
    }),
    loadConfig: config => {
      if (batchRunning) return;
      clearLevel();
      applyEditorConfig(config);
      render();
    },
    runConfigs: runConfigList,
    stopRun: () => batchRunner?.stop(),
  });

  restoreTargetConfigInputs();
  maxWordLengthInput.value = String(configuredMaxWordLength);
  initialMaxWordLengthInput.value = String(configuredInitialMaxWordLength);
  initialForwardInput.value = String(configuredInitialForwardProbability);
  for (const [kind, input] of Object.entries(duplicateRangeInputs)) input.value = String(configuredDuplicateRanges[kind]);
  restoreFilterInputs();
  render();
  loadSavedLevels();
  new ResizeObserver(fitBoard).observe(boardStage);
  window.addEventListener("resize", fitBoard);
})();
