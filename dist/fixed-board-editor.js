import { createVirtualList } from "./virtual-list.js";
import { compileWordSearch } from "./word-search.js";
import { bindLatinWordInput } from "./latin-word-input.js";
import { createTargetPathMonitor } from "./target-path-monitor.js";
import { normalizeDisabledCells, resizeDisabledCells } from "./board-shape.js";
import { normalizeFixedWords, validateFixedWords, normalizeFixedLayout, fixedLayoutLetters } from "./fixed-words.js";
import { describePath } from "./level-statistics.js";
import { bindWordTooltip } from "./word-tooltip.js";
import { createGenerator } from "./level-generator.js";
import { CONFIG_FILTER_OPTIONS } from "./level-config.js";

let vocabularyPromise;
function loadVocabulary() {
  vocabularyPromise ??= Promise.all(["required-words.json", "extra-words.json", "guide-words.json"].map(async file => {
    const response = await fetch(new URL(`./data/${file}`, import.meta.url));
    if (!response.ok) throw new Error("词库加载失败，请重试。");
    return response.json();
  })).then(([normal, extras, guide]) => {
    const excluded = new Set(extras.map(entry => entry.word));
    const words = new Map();
    for (const entry of [...normal, ...guide]) if (/^[A-Z]+$/.test(entry.word) && !entry.onlyExtra && !excluded.has(entry.word)) words.set(entry.word, entry);
    return {
      entries: [...words.values()].sort((a, b) => a.word.localeCompare(b.word)),
      detector: createGenerator([...normal, ...guide], extras),
    };
  }).catch(error => { vocabularyPromise = null; throw error; });
  return vocabularyPromise;
}

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function mountFixedBoardEditor(container, config, { configs = [config], recentWordUsage = new Map(),
  historyReference = "", onError = () => {} } = {}) {
  config = structuredClone(config);
  let { rows, columns } = config;
  let disabledCells = normalizeDisabledCells(config);
  let canPin = configs.every(settings => settings.rows === rows && settings.columns === columns &&
    JSON.stringify(normalizeDisabledCells(settings)) === JSON.stringify(disabledCells));
  let boardChanged = false;
  let editMode = "shape";
  let words = normalizeFixedWords(config.fixedWords);
  // Keep coordinates when the user changes the size. Words outside the new
  // board need an explicit new placement or a switch to automatic placement.
  const pendingPins = new Set();
  let placements = (config.fixedLayout?.placements ?? []).flatMap(entry => {
    const oldColumns = config.fixedLayout.columns;
    const coordinates = entry.path.map(cell => [Math.floor(cell / oldColumns), cell % oldColumns]);
    if (coordinates.every(([row, column]) => row < rows && column < columns && !config.disabledCells?.includes(row * columns + column))) {
      return [{ word: entry.word, path: coordinates.map(([row, column]) => row * columns + column) }];
    }
    pendingPins.add(entry.word);
    return [];
  });
  let activeWord = null, activePath = [], selectedWord = null;
  let vocabulary = null, byWord = new Map(), disposed = false;
  let detector = null, detectionKey = null;
  const selectedLengths = new Set();
  const initialFilters = config.filters ?? {};
  const searchFilters = Object.fromEntries(Object.entries(CONFIG_FILTER_OPTIONS).map(([key, values]) => [key, new Set(initialFilters[key] ?? values)]));
  container.innerHTML = '<div class="fixed-board-editor"><section class="fixed-board-side"><div class="fixed-board-heading"><strong id="fixed-board-size"></strong><button type="button" class="reset-button" data-fixed-action="clear">清空单词</button></div><div class="board-edit-controls"><label>行 <select data-board-dimension="rows" aria-label="棋盘行数"></select></label><label>列 <select data-board-dimension="columns" aria-label="棋盘列数"></select></label><button type="button" class="reset-button" data-board-mode="shape">调整棋盘</button><button type="button" class="reset-button" data-board-mode="words">固定单词</button></div><div class="fixed-board-stage"><div class="fixed-board-grid" role="group" aria-label="固定单词棋盘"></div></div><div class="fixed-placement-status" aria-live="polite"></div><div class="fixed-placement-actions"><button type="button" class="reset-button" data-fixed-action="undo">撤销一格</button><button type="button" class="reset-button" data-fixed-action="cancel">取消摆放</button></div><div class="fixed-preset-list" aria-label="已添加的固定单词"></div></section><section class="fixed-search-side"><label for="fixed-word-search">搜索单词</label><input id="fixed-word-search" type="search" placeholder="输入英文单词，空格表示空位" lang="en" inputmode="url" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" /><div class="fixed-search-count" aria-live="polite"></div><div class="fixed-search-results"></div><button type="button" class="reset-button" data-fixed-action="retry" hidden>重新加载词库</button></section></div>';
  const grid = container.querySelector(".fixed-board-grid");
  const status = container.querySelector(".fixed-placement-status");
  const list = container.querySelector(".fixed-preset-list");
  const search = container.querySelector("#fixed-word-search");
  const searchHint = element("p", "fixed-extra-note", "空格显示为 *，每个 * 代表 1 个字母，同长度匹配优先");
  searchHint.id = "fixed-word-search-hint";
  searchHint.style.margin = "0";
  search.setAttribute("aria-describedby", searchHint.id);
  search.after(searchHint);
  const lengthFilter = element("fieldset", "fixed-length-filter");
  lengthFilter.append(element("legend", "", "单词长度（可多选）"));
  const lengthOptions = element("div", "fixed-length-options");
  lengthFilter.append(lengthOptions);
  search.previousElementSibling.before(lengthFilter);
  const vocabularyFilter = element("details", "fixed-vocabulary-filter");
  const vocabularySummary = element("summary", "", "本关词库筛选 · 全部");
  const vocabularyFields = element("div", "fixed-vocabulary-fields");
  const filterLabels = { scope: "范围库", emotion: "情绪类型", abbreviation: "是否缩写", rarityLevel: "生僻档位" };
  for (const [key, values] of Object.entries(CONFIG_FILTER_OPTIONS)) {
    const field = element("fieldset", "");
    field.append(element("legend", "", filterLabels[key]));
    const options = element("div", "fixed-vocabulary-options");
    for (const value of values) {
      const label = element("label", "");
      const input = document.createElement("input");
      input.type = "checkbox"; input.checked = searchFilters[key].has(value);
      input.dataset.fixedFilter = key; input.value = value;
      const text = key === "scope" && value === 0 ? "2词库"
        : key === "abbreviation" ? (value === 0 ? "非缩写" : "缩写") : String(value);
      label.append(input, document.createTextNode(text)); options.append(label);
    }
    field.append(options); vocabularyFields.append(field);
  }
  const resetFilters = element("button", "reset-button", "重置词库筛选");
  resetFilters.type = "button"; resetFilters.dataset.fixedFilterReset = "true";
  vocabularyFields.append(resetFilters);
  vocabularyFilter.append(vocabularySummary, vocabularyFields);
  lengthFilter.after(vocabularyFilter);
  const results = container.querySelector(".fixed-search-results");
  const searchBrowser = element("div", "fixed-search-browser");
  const letterIndex = element("nav", "fixed-letter-index");
  letterIndex.setAttribute("aria-label", "按首字母跳转");
  const firstByLetter = new Map();
  results.before(searchBrowser);
  searchBrowser.append(results, letterIndex);
  let searchSignature = null;
  const virtualResults = createVirtualList(results, { renderItem: createSearchCard,
    itemSize: ({ entry }) => recentWordUsage.get(entry.word)?.length ? 133 : 104 });
  const resultCount = container.querySelector(".fixed-search-count");
  if (historyReference) {
    const historyNote = element("p", "fixed-extra-note", historyReference);
    resultCount.before(historyNote);
  }
  const undo = container.querySelector('[data-fixed-action="undo"]');
  const cancel = container.querySelector('[data-fixed-action="cancel"]');
  const retry = container.querySelector('[data-fixed-action="retry"]');
  const extraSection = element("section", "fixed-extra-section");
  extraSection.setAttribute("aria-label", "额外词检测");
  const extraCount = element("strong", "fixed-extra-heading", "额外词检测");
  extraCount.setAttribute("aria-live", "polite");
  const extraNote = element("p", "fixed-extra-note", "根据当前已摆放的字母实时检测，不含已添加的固定单词；空白格不参与。");
  const extraResults = element("div", "fixed-extra-results");
  const ambiguityNote = element("p", "fixed-extra-note ambiguity-warning");
  ambiguityNote.setAttribute("role", "status");
  ambiguityNote.hidden = true;
  const targetPathMonitor = createTargetPathMonitor(ambiguityNote, { placedOnly: true });
  extraSection.append(extraCount, extraNote, extraResults, ambiguityNote);
  list.after(extraSection);
  container.querySelector("#fixed-board-size").textContent = `${rows} 行 × ${columns} 列`;
  grid.style.setProperty("--fixed-columns", columns);
  for (const select of container.querySelectorAll("[data-board-dimension]")) {
    for (let size = 2; size <= 5; size++) select.add(new Option(String(size), String(size)));
    select.value = String(config[select.dataset.boardDimension]);
  }

  function draftSettings(settings) {
    return boardChanged || configs.length === 1 ? { ...settings, rows, columns, disabledCells } : settings;
  }

  function updateBoard(next) {
    const nextDisabled = normalizeDisabledCells(next);
    placements = placements.flatMap(entry => {
      const coordinates = entry.path.map(cell => [Math.floor(cell / columns), cell % columns]);
      if (coordinates.some(([row, column]) => row >= next.rows || column >= next.columns || nextDisabled.includes(row * next.columns + column))) {
        pendingPins.add(entry.word);
        return [];
      }
      return [{ ...entry, path: coordinates.map(([row, column]) => row * next.columns + column) }];
    });
    rows = next.rows; columns = next.columns; disabledCells = nextDisabled;
    config = { ...config, rows, columns, disabledCells };
    boardChanged = true; canPin = true;
    activeWord = null; activePath = []; selectedWord = null;
    for (const select of container.querySelectorAll("[data-board-dimension]")) select.value = String(config[select.dataset.boardDimension]);
    onError(""); renderBoard(); renderSearch();
  }

  const changeDimension = event => {
    const dimension = event.target.dataset.boardDimension;
    if (!dimension) return;
    const next = { rows, columns, [dimension]: Number(event.target.value) };
    try {
      next.disabledCells = resizeDisabledCells({ rows, columns, disabledCells }, next);
      updateBoard(next);
    } catch (error) { event.target.value = String(config[dimension]); onError(error.message); }
  };

  function wordIssue(word) {
    const entry = byWord.get(word);
    if (!entry) return vocabulary ? "不在可用初始词库中" : "词库加载中";
    for (const original of configs) {
      const settings = draftSettings(original);
      try {
        validateFixedWords({ ...settings, fixedWords: [...new Set([...words, word])] });
      } catch (error) { return error.message; }
    }
    if (Object.entries(searchFilters).some(([key, selected]) => selected.size !== CONFIG_FILTER_OPTIONS[key].length && !selected.has(entry[key]))) return "不符合当前手动筛选";
    return "";
  }

  function manualFilters() {
    return Object.fromEntries(Object.entries(searchFilters)
      .filter(([key, selected]) => selected.size !== CONFIG_FILTER_OPTIONS[key].length)
      .map(([key, selected]) => [key, [...selected].sort((a, b) => a - b)]));
  }

  function drawPath(path) {
    if (path.length < 2) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${columns * 72 - 8} ${rows * 72 - 8}`);
    svg.classList.add("fixed-board-route");
    svg.setAttribute("aria-hidden", "true");
    const points = path.map(cell => ({ x: 32 + (cell % columns) * 72, y: 32 + Math.floor(cell / columns) * 72 }));
    const end = points.at(-1), before = points.at(-2);
    const dx = Math.sign(end.x - before.x), dy = Math.sign(end.y - before.y);
    const tip = { x: end.x - dx * 19, y: end.y - dy * 19 };
    const base = { x: tip.x - dx * 9, y: tip.y - dy * 9 };
    const color = ["#12b741", "#2563ff", "#ffc400", "#f23030"][Math.min(3, describePath(path, columns).difficultyScore)];
    const line = document.createElementNS(svg.namespaceURI, "polyline");
    line.setAttribute("points", [...points.slice(0, -1), base].map(point => `${point.x},${point.y}`).join(" "));
    line.setAttribute("fill", "none"); line.setAttribute("stroke", color); line.setAttribute("stroke-width", "4");
    line.setAttribute("stroke-linecap", "round"); line.setAttribute("stroke-linejoin", "round");
    const arrow = document.createElementNS(svg.namespaceURI, "polygon");
    arrow.setAttribute("points", `${tip.x},${tip.y} ${base.x - dy * 5},${base.y + dx * 5} ${base.x + dy * 5},${base.y - dx * 5}`);
    arrow.setAttribute("fill", color);
    svg.append(line, arrow); grid.append(svg);
  }

  function renderExtraWords(letters) {
    if (!detector) {
      extraResults.textContent = retry.hidden ? "加载词库…" : "词库加载失败，请重新加载词库。";
      return;
    }
    const key = JSON.stringify([rows, columns, disabledCells, letters, words]);
    if (key === detectionKey) return;
    detectionKey = key;
    // Treat unfinished cells as blocked so the same search used in generation
    // can also inspect the editor's partially filled board.
    const blocked = [...new Set([...disabledCells, ...letters.flatMap((letter, cell) => letter ? [] : [cell])])];
    const fixed = new Set(words);
    const found = detector.findWords({ rows, columns, letters, disabledCells: blocked });
    const extras = found.filter(entry => !fixed.has(entry.word));
    extraCount.textContent = `额外词检测 · ${extras.length} 个`;
    const fragment = document.createDocumentFragment();
    for (const entry of extras) {
      const label = element("span", "fixed-extra-word", entry.word);
      bindWordTooltip(label, entry);
      fragment.append(label);
    }
    if (!extras.length) fragment.append(element("span", "fixed-list-empty", "当前未检测到额外词"));
    extraResults.replaceChildren(fragment);
  }

  function renderBoard() {
    container.querySelector("#fixed-board-size").textContent = `${rows} 行 × ${columns} 列 · ${rows * columns - disabledCells.length} 格`;
    grid.style.setProperty("--fixed-columns", columns);
    for (const button of container.querySelectorAll("[data-board-mode]")) button.setAttribute("aria-pressed", String(button.dataset.boardMode === editMode));
    const base = placements.filter(entry => entry.word !== activeWord);
    const letters = fixedLayoutLetters(rows, columns, base);
    activePath.forEach((cell, index) => { letters[cell] = activeWord[index]; });
    const counts = Array(letters.length).fill(0);
    for (const entry of base) for (const cell of entry.path) counts[cell]++;
    targetPathMonitor.update({ rows, columns, disabledCells,
      cells: letters.map((letter, cell) => ({ letter, count: counts[cell] })), targetWords: base });
    renderExtraWords(letters);
    const path = activeWord ? activePath : placements.find(entry => entry.word === selectedWord)?.path ?? [];
    const fragment = document.createDocumentFragment();
    for (let cell = 0; cell < letters.length; cell++) {
      const button = element("button", `fixed-board-cell${letters[cell] ? " is-filled" : ""}${path.includes(cell) ? " is-selected" : ""}`);
      button.type = "button"; button.dataset.fixedCell = cell;
      const disabled = disabledCells.includes(cell);
      button.disabled = editMode === "words" && disabled;
      button.classList.toggle("is-disabled", disabled);
      button.setAttribute("aria-pressed", String(!disabled));
      button.title = editMode === "shape" ? (disabled ? "点击启用格子" : "点击禁用格子") : "点击摆放固定单词";
      button.setAttribute("aria-label", `第 ${Math.floor(cell / columns) + 1} 行，第 ${cell % columns + 1} 列，${disabled ? "已禁用" : letters[cell] || "空白"}`);
      button.append(element("span", "fixed-cell-letter", letters[cell]));
      if (path.includes(cell)) button.append(element("span", "fixed-cell-step", String(path.indexOf(cell) + 1)));
      fragment.append(button);
    }
    grid.replaceChildren(fragment); drawPath(path);
    status.textContent = editMode === "shape" ? `点击格子启用 / 禁用${configs.length > 1 ? "；完成后将统一所选关卡的棋盘" : ""}` : activeWord
      ? `${activeWord} · ${activePath.length}/${activeWord.length} 格${activePath.length < activeWord.length ? ` · 下一字母 ${activeWord[activePath.length]}` : " · 请调整路径"}`
      : selectedWord ? `${selectedWord} · ${placements.some(entry => entry.word === selectedWord) ? "位置已固定" : pendingPins.has(selectedWord) ? "需重新摆放或改为自动" : "生成时自动摆放"}`
      : canPin ? "可选择自动摆放，或在棋盘上固定位置" : "所选棋盘不同，可自动摆词；调整棋盘后可统一固定位置";
    undo.disabled = !activePath.length;
    cancel.disabled = !activeWord;
    const items = document.createDocumentFragment();
    for (const word of words) {
      const placed = placements.some(entry => entry.word === word);
      const row = element("div", `fixed-preset-row${word === selectedWord || word === activeWord ? " is-selected" : ""}`);
      row.dataset.fixedSelectedWord = word;
      const label = element("button", "fixed-preset-word", word); label.type = "button"; label.dataset.fixedPreview = word;
      bindWordTooltip(label, vocabulary?.find(entry => entry.word === word) ?? { word });
      const state = element("span", "fixed-preset-state", word === activeWord ? "摆放中" : placed ? "固定位置" : pendingPins.has(word) ? "需重新摆放" : "自动摆放");
      const edit = element("button", "reset-button", placed ? "重摆" : "固定位置"); edit.type = "button"; edit.dataset.fixedWord = word;
      edit.disabled = !canPin;
      if (!canPin) edit.title = "所选棋盘不同，调整棋盘后可统一固定位置";
      const remove = element("button", "reset-button fixed-remove", "删除"); remove.type = "button"; remove.dataset.fixedRemove = word;
      row.append(label, state);
      if (placed || activeWord === word || pendingPins.has(word)) {
        const automatic = element("button", "reset-button", "自动摆放");
        automatic.type = "button"; automatic.dataset.fixedAutomatic = word; row.append(automatic);
      }
      row.append(edit, remove); items.append(row);
    }
    list.replaceChildren(items);
    if (!words.length) list.append(element("span", "fixed-list-empty", "暂无固定单词"));
  }

  function renderLengthFilter() {
    const lengths = [...new Set((vocabulary ?? []).map(entry => entry.word.length))].sort((a, b) => a - b);
    const fragment = document.createDocumentFragment();
    for (const length of [null, ...lengths]) {
      const button = element("button", "reset-button", length === null ? "全部" : String(length));
      button.type = "button";
      button.dataset.fixedLength = length === null ? "all" : String(length);
      button.setAttribute("aria-label", length === null ? "全部长度" : `${length} 个字母`);
      button.setAttribute("aria-pressed", String(length === null ? !selectedLengths.size : selectedLengths.has(length)));
      fragment.append(button);
    }
    lengthOptions.replaceChildren(fragment);
  }

  function createSearchCard({ entry, issue: suppliedIssue }) {
    const issue = suppliedIssue ?? wordIssue(entry.word);
    const selected = words.includes(entry.word), pinned = placements.some(item => item.word === entry.word);
    const card = element("div", `fixed-search-result${selected ? " is-selected" : ""}${issue ? " is-disabled" : ""}`);
    const heading = element("span", "fixed-result-heading");
    const wordLabel = element("strong", "", entry.word);
    bindWordTooltip(wordLabel, entry);
    heading.append(wordLabel, element("span", "", issue ? "不可用" : pinned ? "固定位置" : selected ? "已选择" : ""));
    const actions = element("div", "fixed-result-actions");
    const automatic = element("button", "reset-button", "自动摆放"); automatic.type = "button"; automatic.dataset.fixedAutomatic = entry.word;
    automatic.disabled = Boolean(issue) || (selected && !pinned && !pendingPins.has(entry.word) && activeWord !== entry.word);
    const manual = element("button", "reset-button", pinned ? "重摆" : "固定位置"); manual.type = "button"; manual.dataset.fixedWord = entry.word;
    manual.disabled = Boolean(issue) || !canPin;
    if (!canPin) manual.title = "所选棋盘不同，调整棋盘后可统一固定位置";
    actions.append(automatic, manual);
    card.append(heading);
    const recentLevels = recentWordUsage.get(entry.word);
    if (recentLevels?.length) {
      card.classList.add("has-recent-usage");
      card.dataset.recentWordUse = "true";
      const numbers = recentLevels.map(number => String(number).padStart(3, "0"));
      const badge = element("span", "fixed-recent-usage", `前50关用过 · 第 ${numbers.slice(0, 4).join("、")} 关${numbers.length > 4 ? `等 ${numbers.length} 关` : ""}`);
      badge.title = `前50关用过：第 ${numbers.join("、")} 关`;
      card.append(badge);
    }
    card.append(element("span", "fixed-result-definition", issue || entry.definitionZh || entry.definitionEn || "暂无释义"), actions);
    return card;
  }

  function renderSearch() {
    if (!vocabulary) { resultCount.textContent = "加载词库…"; return; }
    const matcher = compileWordSearch(search.value);
    const query = matcher.query;
    const activeFilters = Object.entries(searchFilters).filter(([key, selected]) => selected.size !== CONFIG_FILTER_OPTIONS[key].length);
    const matches = vocabulary.filter(entry => (!selectedLengths.size || selectedLengths.has(entry.word.length)) &&
      activeFilters.every(([key, selected]) => selected.has(entry[key])) && matcher.matches(entry))
      .map(entry => ({ entry, issue: query ? wordIssue(entry.word) : null }));
    if (query) matches.sort((a, b) => Number(matcher.exact(b.entry)) - Number(matcher.exact(a.entry)) ||
        Number(Boolean(a.issue)) - Number(Boolean(b.issue)) ||
        Number(matcher.startsWith(b.entry)) - Number(matcher.startsWith(a.entry)) || a.entry.word.localeCompare(b.entry.word));
    resultCount.textContent = matches.length ? `${matches.length} 个结果${query && matches.length > 60 ? " · 显示前 60 个" : ""}` : "没有匹配的单词";
    firstByLetter.clear();
    const displayed = query ? matches.slice(0, 60) : matches;
    displayed.forEach(({ entry }, index) => {
      if (!firstByLetter.has(entry.word[0])) firstByLetter.set(entry.word[0], index);
    });
    const signature = JSON.stringify([query, [...selectedLengths], manualFilters()]);
    virtualResults.setItems(displayed, { resetScroll: signature !== searchSignature });
    searchSignature = signature;
    const letters = document.createDocumentFragment();
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const button = element("button", "", letter);
      button.type = "button"; button.dataset.fixedLetter = letter;
      button.setAttribute("aria-label", `跳到 ${letter} 开头的单词`);
      button.disabled = !firstByLetter.has(letter);
      letters.append(button);
    }
    letterIndex.replaceChildren(letters);
    letterIndex.hidden = Boolean(query);
  }

  function startWord(word) {
    if (!canPin) { onError("所选棋盘不同，请先调整棋盘以统一布局，或选择自动摆放。"); return; }
    const issue = wordIssue(word);
    if (issue) { onError(`${word}：${issue}`); return; }
    if (!words.includes(word)) words.push(word);
    editMode = "words";
    activeWord = word; activePath = []; selectedWord = null;
    onError(""); renderBoard(); renderSearch();
  }

  function useAutomatic(word) {
    const issue = wordIssue(word);
    if (issue) { onError(`${word}：${issue}`); return; }
    if (!words.includes(word)) words.push(word);
    placements = placements.filter(entry => entry.word !== word);
    pendingPins.delete(word);
    if (activeWord === word) { activeWord = null; activePath = []; }
    if (!activeWord) selectedWord = word;
    onError(""); renderBoard(); renderSearch();
  }

  function chooseCell(cell) {
    if (editMode === "shape") {
      const disabled = new Set(disabledCells);
      if (disabled.has(cell)) disabled.delete(cell); else disabled.add(cell);
      try { updateBoard({ rows, columns, disabledCells: [...disabled] }); }
      catch (error) { onError(error.message); }
      grid.querySelector(`[data-fixed-cell="${cell}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (!activeWord) {
      const entry = placements.find(placement => placement.path.includes(cell));
      if (entry) { selectedWord = entry.word; renderBoard(); }
      else onError("请先在右侧选择单词。");
      return;
    }
    if (cell === activePath.at(-1)) { activePath.pop(); onError(""); renderBoard(); return; }
    if (activePath.length >= activeWord.length) { onError("请撤销一格或重新摆放。"); return; }
    if (activePath.includes(cell)) { onError("同一个单词不能重复使用格子。"); return; }
    const last = activePath.at(-1);
    if (last !== undefined && Math.abs(Math.floor(cell / columns) - Math.floor(last / columns)) + Math.abs(cell % columns - last % columns) !== 1) {
      onError("请选择上、下、左、右相邻的格子。"); return;
    }
    const base = placements.filter(entry => entry.word !== activeWord);
    const letters = fixedLayoutLetters(rows, columns, base);
    const letter = activeWord[activePath.length];
    if (letters[cell] && letters[cell] !== letter) { onError(`该格为 ${letters[cell]}，当前需要 ${letter}。`); return; }
    activePath.push(cell); onError("");
    if (activePath.length === activeWord.length) {
      const nextWords = [...new Set([...words, activeWord])];
      const nextLayout = { rows, columns, placements: [...base, { word: activeWord, path: [...activePath] }] };
      try {
        normalizeFixedLayout({ ...config, rows, columns, fixedWords: nextWords, fixedLayout: nextLayout });
        words = nextWords; placements = nextLayout.placements; selectedWord = activeWord;
        pendingPins.delete(activeWord);
        activeWord = null; activePath = []; renderSearch();
      } catch (error) { onError(error.message); }
    }
    renderBoard();
    grid.querySelector(`[data-fixed-cell="${cell}"]`)?.focus({ preventScroll: true });
  }

  const click = event => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.dataset.fixedFilterReset) {
      for (const [key, values] of Object.entries(CONFIG_FILTER_OPTIONS)) searchFilters[key] = new Set(values);
      vocabularyFields.querySelectorAll("input").forEach(input => { input.checked = true; });
      syncFilters({}); return;
    }
    if (button.dataset.fixedLetter) {
      const index = firstByLetter.get(button.dataset.fixedLetter);
      if (index !== undefined) virtualResults.scrollToIndex(index);
      return;
    }
    if (button.dataset.fixedLength !== undefined) {
      const length = Number(button.dataset.fixedLength);
      if (button.dataset.fixedLength === "all") selectedLengths.clear();
      else if (selectedLengths.has(length)) selectedLengths.delete(length);
      else selectedLengths.add(length);
      renderLengthFilter(); renderSearch();
      lengthOptions.querySelector(`[data-fixed-length="${button.dataset.fixedLength}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (button.dataset.boardMode) {
      editMode = button.dataset.boardMode;
      activeWord = null; activePath = []; selectedWord = null;
      onError(""); renderBoard(); return;
    }
    if (button.dataset.fixedAutomatic) { useAutomatic(button.dataset.fixedAutomatic); return; }
    if (button.dataset.fixedWord) { startWord(button.dataset.fixedWord); return; }
    if (button.dataset.fixedCell !== undefined) { chooseCell(Number(button.dataset.fixedCell)); return; }
    if (button.dataset.fixedRemove) {
      const word = button.dataset.fixedRemove;
      words = words.filter(entry => entry !== word); placements = placements.filter(entry => entry.word !== word);
      pendingPins.delete(word);
      if (activeWord === word) { activeWord = null; activePath = []; }
      if (selectedWord === word) selectedWord = null;
    } else if (button.dataset.fixedPreview) {
      selectedWord = button.dataset.fixedPreview; activeWord = null; activePath = [];
    } else if (button.dataset.fixedAction === "undo") activePath.pop();
    else if (button.dataset.fixedAction === "cancel") { activeWord = null; activePath = []; }
    else if (button.dataset.fixedAction === "clear") { words = []; placements = []; pendingPins.clear(); activeWord = null; activePath = []; selectedWord = null; }
    else if (button.dataset.fixedAction === "retry") { load(); return; }
    onError(""); renderBoard(); renderSearch();
  };
  async function load() {
    retry.hidden = true; resultCount.textContent = "加载词库…";
    renderBoard();
    try {
      const { entries, detector: loadedDetector } = await loadVocabulary();
      if (disposed) return;
      vocabulary = entries; detector = loadedDetector;
      byWord = new Map(entries.map(entry => [entry.word, entry])); renderLengthFilter(); renderBoard(); renderSearch();
    } catch (error) {
      if (disposed) return;
      resultCount.textContent = "词库加载失败"; retry.hidden = false; onError(error.message);
      renderBoard();
    }
  }
  const changeSearchFilter = event => {
    const key = event.target.dataset.fixedFilter;
    if (!Object.hasOwn(searchFilters, key)) return;
    const value = Number(event.target.value);
    if (event.target.checked) searchFilters[key].add(value);
    else searchFilters[key].delete(value);
    syncFilters(manualFilters());
  };
  function syncFilters(filters) {
    for (const [key, values] of Object.entries(CONFIG_FILTER_OPTIONS)) searchFilters[key] = new Set(filters[key] ?? values);
    vocabularyFields.querySelectorAll("input").forEach(input => {
      input.checked = searchFilters[input.dataset.fixedFilter].has(Number(input.value));
    });
    vocabularySummary.textContent = `本关词库筛选 · ${Object.keys(filters).length ? "已筛选" : "全部"}`;
    if (vocabulary) { renderBoard(); renderSearch(); }
  }
  syncFilters(initialFilters);
  container.addEventListener("click", click);
  container.addEventListener("change", changeDimension);
  vocabularyFilter.addEventListener("change", changeSearchFilter);
  const unbindSearchInput = bindLatinWordInput(search, renderSearch);
  renderLengthFilter(); renderBoard(); load();
  return {
    getValue() {
      if (activeWord) throw new Error(`请先摆完 ${activeWord}，或将它改为自动摆放。`);
      if (pendingPins.size) throw new Error(`棋盘已调整，请重新摆放 ${[...pendingPins].join("、")} 或将其改为自动摆放。`);
      if (placements.length && !canPin) throw new Error("所选棋盘不同，请先调整棋盘以统一布局，或将固定词改为自动摆放后应用。");
      for (const word of words) { const issue = wordIssue(word); if (issue) throw new Error(`${word}：${issue}`); }
      const fixedLayout = placements.length ? { rows, columns, placements: structuredClone(placements) } : null;
      return { ...(boardChanged || configs.length === 1 ? { rows, columns, disabledCells: [...disabledCells] } : {}), filters: manualFilters(), fixedWords: [...words], fixedLayout: normalizeFixedLayout({ ...config, rows, columns, fixedWords: words, fixedLayout }) };
    },
    destroy() { disposed = true; virtualResults.destroy(); targetPathMonitor.destroy(); container.removeEventListener("click", click); container.removeEventListener("change", changeDimension); vocabularyFilter.removeEventListener("change", changeSearchFilter); unbindSearchInput(); },
  };
}

export function createConfigBoardPreview(config) {
  const { rows, columns } = config;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("config-board-preview");
  if (![rows, columns].every(value => Number.isInteger(value) && value >= 2 && value <= 5)) {
    svg.setAttribute("viewBox", "0 0 104 64");
    return svg;
  }
  const gap = 1;
  const cellSize = Math.min((100 - (columns - 1) * gap) / columns, (52 - (rows - 1) * gap) / rows);
  const width = columns * cellSize + (columns - 1) * gap + 8;
  svg.setAttribute("viewBox", `0 0 ${width} 60`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", "60");
  svg.setAttribute("aria-hidden", "true");
  const letters = Array(rows * columns).fill("");
  const layout = config.fixedLayout;
  for (const entry of layout?.placements ?? []) {
    entry.path.forEach((cell, step) => {
      const row = Math.floor(cell / layout.columns), column = cell % layout.columns;
      if (row < rows && column < columns) letters[row * columns + column] = entry.word[step];
    });
  }
  for (let cell = 0; cell < rows * columns; cell++) {
    const disabled = config.disabledCells?.includes(cell);
    const x = (cell % columns) * (cellSize + gap) + 4;
    const y = Math.floor(cell / columns) * (cellSize + gap) + (60 - (rows * cellSize + (rows - 1) * gap)) / 2;
    const rect = document.createElementNS(svg.namespaceURI, "rect");
    for (const [key, value] of Object.entries({ x: x + 0.4, y: y + 0.4, width: cellSize - 0.8, height: cellSize - 0.8, rx: 2,
      fill: disabled ? "none" : "#fffefa", stroke: disabled ? "#b9c3b2" : "#dce3d3", "stroke-width": 0.8 })) rect.setAttribute(key, String(value));
    if (disabled) rect.setAttribute("stroke-dasharray", "2 2");
    svg.append(rect);
    if (!disabled && letters[cell]) {
      const text = document.createElementNS(svg.namespaceURI, "text");
      text.setAttribute("x", String(x + cellSize / 2)); text.setAttribute("y", String(y + cellSize / 2));
      text.setAttribute("text-anchor", "middle"); text.setAttribute("dominant-baseline", "central");
      text.setAttribute("fill", "#334d36"); text.setAttribute("font-size", String(Math.min(14, cellSize * 0.7))); text.setAttribute("font-weight", "800");
      text.textContent = letters[cell]; svg.append(text);
    }
  }
  return svg;
}
