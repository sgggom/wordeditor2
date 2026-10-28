import { normalizeFixedWords, validateFixedWords, normalizeFixedLayout, fixedLayoutLetters } from "./fixed-words.js";
import { countTargetLengthPlan } from "./level-generator.js";
import { describePath } from "./level-statistics.js";

let vocabularyPromise;
function loadVocabulary() {
  vocabularyPromise ??= Promise.all(["required-words.json", "extra-words.json"].map(async file => {
    const response = await fetch(new URL(`./data/${file}`, import.meta.url));
    if (!response.ok) throw new Error("词库加载失败，请重试。");
    return response.json();
  })).then(([normal, extras]) => {
    const excluded = new Set(extras.map(entry => entry.word));
    const words = new Map();
    for (const entry of normal) if (/^[A-Z]+$/.test(entry.word) && !entry.onlyExtra && !excluded.has(entry.word)) words.set(entry.word, entry);
    return [...words.values()].sort((a, b) => a.word.localeCompare(b.word));
  }).catch(error => { vocabularyPromise = null; throw error; });
  return vocabularyPromise;
}

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function mountFixedBoardEditor(container, config, { configs = [config], onError = () => {} } = {}) {
  const { rows, columns } = config;
  const canPin = configs.every(settings => settings.rows === rows && settings.columns === columns);
  let words = normalizeFixedWords(config.fixedWords);
  // Keep coordinates when the user changes the size. Words outside the new
  // board need an explicit new placement or a switch to automatic placement.
  const pendingPins = new Set();
  let placements = (config.fixedLayout?.placements ?? []).flatMap(entry => {
    const oldColumns = config.fixedLayout.columns;
    const coordinates = entry.path.map(cell => [Math.floor(cell / oldColumns), cell % oldColumns]);
    if (coordinates.every(([row, column]) => row < rows && column < columns)) {
      return [{ word: entry.word, path: coordinates.map(([row, column]) => row * columns + column) }];
    }
    pendingPins.add(entry.word);
    return [];
  });
  let activeWord = null, activePath = [], selectedWord = null;
  let vocabulary = null, byWord = new Map(), disposed = false;
  container.innerHTML = '<div class="fixed-board-editor"><section class="fixed-board-side"><div class="fixed-board-heading"><strong id="fixed-board-size"></strong><button type="button" class="reset-button" data-fixed-action="clear">清空</button></div><div class="fixed-board-stage"><div class="fixed-board-grid" role="group" aria-label="固定单词棋盘"></div></div><div class="fixed-placement-status" aria-live="polite"></div><div class="fixed-placement-actions"><button type="button" class="reset-button" data-fixed-action="undo">撤销一格</button><button type="button" class="reset-button" data-fixed-action="cancel">取消摆放</button></div><div class="fixed-preset-list" aria-label="已添加的固定单词"></div></section><section class="fixed-search-side"><label for="fixed-word-search">搜索单词</label><input id="fixed-word-search" type="search" placeholder="输入单词或释义" autocomplete="off" spellcheck="false" /><div class="fixed-search-count" aria-live="polite"></div><div class="fixed-search-results"></div><button type="button" class="reset-button" data-fixed-action="retry" hidden>重新加载词库</button></section></div>';
  const grid = container.querySelector(".fixed-board-grid");
  const status = container.querySelector(".fixed-placement-status");
  const list = container.querySelector(".fixed-preset-list");
  const search = container.querySelector("#fixed-word-search");
  const results = container.querySelector(".fixed-search-results");
  const resultCount = container.querySelector(".fixed-search-count");
  const undo = container.querySelector('[data-fixed-action="undo"]');
  const cancel = container.querySelector('[data-fixed-action="cancel"]');
  const retry = container.querySelector('[data-fixed-action="retry"]');
  container.querySelector("#fixed-board-size").textContent = `${rows} 行 × ${columns} 列`;
  grid.style.setProperty("--fixed-columns", columns);

  function wordIssue(word) {
    const entry = byWord.get(word);
    if (!entry) return vocabulary ? "不在可用初始词库中" : "词库加载中";
    for (const settings of configs) {
      try {
        validateFixedWords({ ...settings, fixedWords: [...new Set([...words, word])] }, countTargetLengthPlan(settings.targetCount, settings.targetLengthPlan));
      } catch (error) { return error.message; }
      if (Object.entries(settings.filters ?? {}).some(([key, values]) => !values.includes(entry[key]))) return "不符合词库筛选";
      if (entry.rarityLevel !== 1) return "初始词生僻档位需为 1";
    }
    return "";
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

  function renderBoard() {
    const base = placements.filter(entry => entry.word !== activeWord);
    const letters = fixedLayoutLetters(rows, columns, base);
    activePath.forEach((cell, index) => { letters[cell] = activeWord[index]; });
    const path = activeWord ? activePath : placements.find(entry => entry.word === selectedWord)?.path ?? [];
    const fragment = document.createDocumentFragment();
    for (let cell = 0; cell < letters.length; cell++) {
      const button = element("button", `fixed-board-cell${letters[cell] ? " is-filled" : ""}${path.includes(cell) ? " is-selected" : ""}`);
      button.type = "button"; button.dataset.fixedCell = cell;
      button.setAttribute("aria-label", `第 ${Math.floor(cell / columns) + 1} 行，第 ${cell % columns + 1} 列，${letters[cell] || "空白"}`);
      button.append(element("span", "fixed-cell-letter", letters[cell]));
      if (path.includes(cell)) button.append(element("span", "fixed-cell-step", String(path.indexOf(cell) + 1)));
      fragment.append(button);
    }
    grid.replaceChildren(fragment); drawPath(path);
    status.textContent = activeWord
      ? `${activeWord} · ${activePath.length}/${activeWord.length} 格${activePath.length < activeWord.length ? ` · 下一字母 ${activeWord[activePath.length]}` : " · 请调整路径"}`
      : selectedWord ? `${selectedWord} · ${placements.some(entry => entry.word === selectedWord) ? "位置已固定" : pendingPins.has(selectedWord) ? "需重新摆放或改为自动" : "生成时自动摆放"}`
      : canPin ? "可选择自动摆放，或在棋盘上固定位置" : "所选棋盘尺寸不同，可选择自动摆放";
    undo.disabled = !activePath.length;
    cancel.disabled = !activeWord;
    const items = document.createDocumentFragment();
    for (const word of words) {
      const placed = placements.some(entry => entry.word === word);
      const row = element("div", `fixed-preset-row${word === selectedWord || word === activeWord ? " is-selected" : ""}`);
      row.dataset.fixedSelectedWord = word;
      const label = element("button", "fixed-preset-word", word); label.type = "button"; label.dataset.fixedPreview = word;
      const state = element("span", "fixed-preset-state", word === activeWord ? "摆放中" : placed ? "固定位置" : pendingPins.has(word) ? "需重新摆放" : "自动摆放");
      const edit = element("button", "reset-button", placed ? "重摆" : "固定位置"); edit.type = "button"; edit.dataset.fixedWord = word;
      edit.disabled = !canPin;
      if (!canPin) edit.title = "所选关卡尺寸不同，不能批量固定位置";
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

  function renderSearch() {
    if (!vocabulary) { resultCount.textContent = "加载词库…"; return; }
    const query = search.value.trim(), upper = query.toUpperCase();
    const matches = vocabulary.filter(entry => !query || entry.word.includes(upper) || String(entry.definitionZh ?? "").includes(query))
      .map(entry => ({ entry, issue: wordIssue(entry.word) })).filter(item => query || !item.issue)
      .sort((a, b) => Number(b.entry.word === upper) - Number(a.entry.word === upper) ||
        Number(Boolean(a.issue)) - Number(Boolean(b.issue)) ||
        Number(b.entry.word.startsWith(upper)) - Number(a.entry.word.startsWith(upper)) || a.entry.word.localeCompare(b.entry.word));
    resultCount.textContent = matches.length ? `${matches.length} 个结果${matches.length > 60 ? " · 显示前 60 个" : ""}` : "没有匹配的单词";
    const fragment = document.createDocumentFragment();
    for (const { entry, issue } of matches.slice(0, 60)) {
      const selected = words.includes(entry.word), pinned = placements.some(item => item.word === entry.word);
      const card = element("div", `fixed-search-result${selected ? " is-selected" : ""}${issue ? " is-disabled" : ""}`);
      card.title = issue || entry.definitionZh || entry.definitionEn || entry.word;
      const heading = element("span", "fixed-result-heading");
      heading.append(element("strong", "", entry.word), element("span", "", issue ? "不可用" : pinned ? "固定位置" : selected ? "已选择" : ""));
      const actions = element("div", "fixed-result-actions");
      const automatic = element("button", "reset-button", "自动摆放"); automatic.type = "button"; automatic.dataset.fixedAutomatic = entry.word;
      automatic.disabled = Boolean(issue) || (selected && !pinned && !pendingPins.has(entry.word) && activeWord !== entry.word);
      const manual = element("button", "reset-button", pinned ? "重摆" : "固定位置"); manual.type = "button"; manual.dataset.fixedWord = entry.word;
      manual.disabled = Boolean(issue) || !canPin;
      if (!canPin) manual.title = "所选关卡尺寸不同，不能批量固定位置";
      actions.append(automatic, manual);
      card.append(heading, element("span", "fixed-result-definition", issue || entry.definitionZh || entry.definitionEn || "暂无释义"), actions);
      fragment.append(card);
    }
    results.replaceChildren(fragment); results.scrollTop = 0;
  }

  function startWord(word) {
    if (!canPin) { onError("所选关卡尺寸不同，请选择自动摆放。"); return; }
    const issue = wordIssue(word);
    if (issue) { onError(`${word}：${issue}`); return; }
    if (!words.includes(word)) words.push(word);
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
        normalizeFixedLayout({ rows, columns, fixedWords: nextWords, fixedLayout: nextLayout });
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
    try {
      const entries = await loadVocabulary();
      if (disposed) return;
      vocabulary = entries; byWord = new Map(entries.map(entry => [entry.word, entry])); renderSearch();
    } catch (error) {
      if (disposed) return;
      resultCount.textContent = "词库加载失败"; retry.hidden = false; onError(error.message);
    }
  }
  container.addEventListener("click", click);
  search.addEventListener("input", renderSearch);
  renderBoard(); load();
  return {
    getValue() {
      if (activeWord) throw new Error(`请先摆完 ${activeWord}，或将它改为自动摆放。`);
      if (pendingPins.size) throw new Error(`棋盘尺寸已变化，请重新摆放 ${[...pendingPins].join("、")} 或将其改为自动摆放。`);
      if (placements.length && !canPin) throw new Error("所选棋盘尺寸不同，请将固定位置的词改为自动摆放后应用。");
      for (const word of words) { const issue = wordIssue(word); if (issue) throw new Error(`${word}：${issue}`); }
      const fixedLayout = placements.length ? { rows, columns, placements: structuredClone(placements) } : null;
      return { fixedWords: [...words], fixedLayout: normalizeFixedLayout({ rows, columns, fixedWords: words, fixedLayout }) };
    },
    destroy() { disposed = true; container.removeEventListener("click", click); search.removeEventListener("input", renderSearch); },
  };
}
