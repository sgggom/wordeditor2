export function normalizePresetLevels(data, format) {
  const levels = format === "word-tiles" ? data : data?.records?.map(record => record.level);
  if (!Array.isArray(levels) || !levels.length) throw new Error("预设关卡列表为空。");
  return levels.map((level, index) => {
    const reference = format === "word-tiles";
    const rows = reference ? level.height : level.rows;
    const columns = reference ? level.width : level.columns;
    const letters = reference ? [...level.letters.replaceAll(",", "")] : level.cells.map(cell => cell.letter);
    const targetWords = (reference ? level.target_words : level.targetWords).map(entry => ({ ...entry }));
    const extraWords = (reference ? level.extra_words : level.extraWords).map(entry => ({ ...entry }));
    if (![2, 3].includes(rows) || ![3, 4, 5].includes(columns) || letters.length !== rows * columns ||
        letters.some(letter => !/^[A-Z]$/.test(letter)) || !targetWords.length ||
        [...targetWords, ...extraWords].some(entry => !/^[A-Z]+$/.test(entry.word))) {
      throw new Error(`第 ${index + 1} 关数据无效。`);
    }
    return { rows, columns, letters, targetWords, extraWords, sourceId: reference ? level.id : null };
  });
}

export function findPresetWordPath(level, word) {
  const { letters, columns } = level;
  function visit(cell, path, used) {
    if (letters[cell] !== word[path.length]) return null;
    const next = [...path, cell];
    if (next.length === word.length) return next;
    const neighbors = [cell - columns, cell + columns,
      ...(cell % columns ? [cell - 1] : []), ...(cell % columns < columns - 1 ? [cell + 1] : [])];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || neighbor >= letters.length || used.has(neighbor)) continue;
      const result = visit(neighbor, next, new Set([...used, neighbor]));
      if (result) return result;
    }
    return null;
  }
  for (let cell = 0; cell < letters.length; cell++) {
    const path = visit(cell, [], new Set([cell]));
    if (path) return path;
  }
  return null;
}

export function setupPresetLevelLists() {
  const dialog = document.querySelector("#preset-level-dialog");
  const source = document.querySelector("#preset-level-source");
  const list = document.querySelector("#preset-level-items");
  const preview = document.querySelector("#preset-level-preview");
  const error = document.querySelector("#preset-level-error");
  const jump = document.querySelector("#preset-level-jump");
  const summary = document.querySelector("#preset-level-summary");
  const download = document.querySelector("#preset-level-download");
  let presets = [];
  let levels = [];
  let activeIndex = 0;
  let request = 0;
  let selectedWord = null;
  let previousSelection = null;

  async function read(file) {
    const response = await fetch(new URL(file, new URL("./data/", import.meta.url)));
    if (!response.ok) throw new Error("预设关卡读取失败，请重试。");
    return response.json();
  }

  function showFailure(failure) {
    error.textContent = failure.message;
    error.hidden = false;
  }

  function renderPreview() {
    const level = levels[activeIndex];
    if (!level) return;
    jump.value = String(activeIndex + 1);
    previousSelection?.setAttribute("aria-pressed", "false");
    previousSelection = list.children[activeIndex];
    previousSelection?.setAttribute("aria-pressed", "true");
    const heading = document.createElement("h3");
    heading.textContent = `关卡 ${String(activeIndex + 1).padStart(3, "0")} · ${level.rows} × ${level.columns}`;
    const metadata = document.createElement("p");
    metadata.className = "preset-level-metadata";
    metadata.textContent = `目标词 ${level.targetWords.length} · 额外词 ${level.extraWords.length}` +
      (level.sourceId === null ? "" : ` · 原关卡 ID ${level.sourceId}`);
    const board = document.createElement("div");
    board.className = "preset-level-board";
    board.style.setProperty("--preset-columns", String(level.columns));
    board.setAttribute("aria-label", "关卡棋盘");
    const selected = [...level.targetWords, ...level.extraWords].find(entry => entry.word === selectedWord);
    const path = selected ? selected.path ?? findPresetWordPath(level, selected.word) : [];
    level.letters.forEach((letter, index) => {
      const cell = document.createElement("div");
      cell.className = "preset-level-cell";
      cell.textContent = letter;
      const step = path?.indexOf(index) ?? -1;
      if (step >= 0) {
        cell.classList.add("is-selected");
        const order = document.createElement("small");
        order.textContent = String(step + 1);
        cell.append(order);
      }
      board.append(cell);
    });
    preview.replaceChildren(heading, metadata, board);
    for (const [label, words] of [["目标词", level.targetWords], ["额外词", level.extraWords]]) {
      const title = document.createElement("h4");
      title.textContent = `${label}（${words.length}）`;
      const group = document.createElement("div");
      group.className = "preset-level-words";
      for (const entry of words) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "reset-button";
        button.textContent = entry.word;
        button.dataset.presetWord = entry.word;
        button.setAttribute("aria-pressed", String(entry.word === selectedWord));
        group.append(button);
      }
      preview.append(title, group);
    }
  }

  function selectLevel(index, scroll = false) {
    if (!Number.isInteger(index) || index < 0 || index >= levels.length) return;
    activeIndex = index;
    selectedWord = null;
    renderPreview();
    if (scroll) list.children[index]?.scrollIntoView({ block: "nearest" });
  }

  async function loadPreset() {
    const token = ++request;
    const preset = presets.find(item => item.id === source.value);
    if (!preset) return;
    error.hidden = true;
    levels = [];
    list.replaceChildren();
    preview.replaceChildren();
    previousSelection = null;
    jump.disabled = true;
    download.hidden = true;
    summary.textContent = "读取中…";
    try {
      const result = normalizePresetLevels(await read(preset.file), preset.format);
      if (token !== request) return;
      if (result.length !== preset.levelCount) throw new Error("预设关卡数量与记录不一致。");
      levels = result;
      summary.textContent = `${preset.label} · ${levels.length} 关`;
      jump.max = String(levels.length);
      jump.disabled = false;
      const fragment = document.createDocumentFragment();
      levels.forEach((level, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "preset-level-item";
        button.dataset.presetIndex = String(index);
        button.setAttribute("aria-pressed", "false");
        button.textContent = `${String(index + 1).padStart(3, "0")}　${level.targetWords.map(entry => entry.word).join(" · ")}`;
        fragment.append(button);
      });
      list.replaceChildren(fragment);
      list.scrollTop = 0;
      if (preset.gameFile) {
        download.href = new URL(preset.gameFile, new URL("./data/", import.meta.url)).href;
        download.download = `${preset.id}-word-tiles-levels.json`;
        download.hidden = false;
      }
      selectLevel(0);
    } catch (failure) {
      if (token !== request) return;
      summary.textContent = "读取失败";
      showFailure(failure);
    }
  }

  document.querySelector("#open-preset-levels").addEventListener("click", async () => {
    if (dialog.open) return;
    dialog.showModal();
    error.hidden = true;
    if (presets.length) return;
    source.disabled = true;
    try {
      const [reference, history] = await Promise.all([read("preset-level-lists.json"), read("local-versions.json")]);
      const versions = history.versions.map(version => ({ ...version, file: version.levels, format: "editor" }));
      presets = [...versions, ...reference.referenceLists];
      source.replaceChildren();
      for (const [label, entries] of [["我们的本地版本", versions], ["参考竞品", reference.referenceLists]]) {
        const group = document.createElement("optgroup");
        group.label = label;
        for (const preset of entries) group.append(new Option(`${preset.label}（${preset.levelCount} 关）`, preset.id));
        source.append(group);
      }
      source.disabled = false;
      source.value = versions.at(-1)?.id ?? presets[0]?.id;
      await loadPreset();
    } catch (failure) { showFailure(failure); }
  });
  source.addEventListener("change", loadPreset);
  document.querySelector("#close-preset-levels").addEventListener("click", () => dialog.close());
  list.addEventListener("click", event => {
    const button = event.target.closest("[data-preset-index]");
    if (button) selectLevel(Number(button.dataset.presetIndex));
  });
  list.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key) || !levels.length) return;
    event.preventDefault();
    selectLevel(Math.max(0, Math.min(levels.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1))), true);
    list.children[activeIndex]?.focus({ preventScroll: true });
  });
  jump.addEventListener("change", () => selectLevel(jump.valueAsNumber - 1, true));
  preview.addEventListener("click", event => {
    const button = event.target.closest("[data-preset-word]");
    if (!button) return;
    selectedWord = selectedWord === button.dataset.presetWord ? null : button.dataset.presetWord;
    renderPreview();
    [...preview.querySelectorAll("[data-preset-word]")].find(item => item.dataset.presetWord === button.dataset.presetWord)?.focus();
  });
}
