import { createPlaytestState, extendPlaytestPath, playtestComplete, submitPlaytestPath } from "./playtest.js";

export function setupPlaytest({ getLevel, getLevelKey = () => null, getLabel = () => "当前关卡", isBusy = () => false, onError = () => {} }) {
  const openButton = document.querySelector("#open-playtest");
  const dialog = document.querySelector("#playtest-dialog");
  const backdrop = document.querySelector("#playtest-backdrop");
  const levelListPanel = document.querySelector(".saved-level-panel");
  const board = document.querySelector("#playtest-board");
  const trail = document.querySelector("#playtest-trail");
  const selection = document.querySelector("#playtest-selection");
  const feedback = document.querySelector("#playtest-feedback");
  const submit = document.querySelector("#playtest-submit");
  const clear = document.querySelector("#playtest-clear");
  const reveal = document.querySelector("#playtest-reveal");
  const answers = document.querySelector("#playtest-targets");
  const extras = document.querySelector("#playtest-extras");
  const progress = document.querySelector("#playtest-progress");
  const progressText = document.querySelector("#playtest-progress-text");
  let initial = null, state = null, path = [], pointer = null, moved = false;
  let sourceKey = null;
  let tiles = [];
  const inertBefore = new Map();

  function levelKey(level) {
    return JSON.stringify([getLevelKey(), level.rows, level.columns, level.disabledCells,
      level.cells.map(cell => [cell.letter, cell.count, Boolean(cell.disabled)]),
      level.targetWords.map(entry => entry.word), level.extraWords?.map(entry => entry.word)]);
  }

  function positionPanel() {
    if (!dialog.open) return;
    const padding = parseFloat(getComputedStyle(document.querySelector(".main")).paddingLeft) || 12;
    const list = levelListPanel.getBoundingClientRect();
    const top = document.querySelector(".app-header").getBoundingClientRect().bottom + 12;
    const besideList = list.left > padding + 280;
    const width = Math.min(830, besideList ? list.left - padding - 12 : window.innerWidth - padding * 2);
    const height = Math.max(160, (besideList ? window.innerHeight - padding : list.top - 12) - top);
    dialog.style.setProperty("--playtest-left", `${padding}px`);
    dialog.style.setProperty("--playtest-top", `${top}px`);
    dialog.style.setProperty("--playtest-width", `${width}px`);
    dialog.style.setProperty("--playtest-height", `${height}px`);
    dialog.classList.toggle("is-compact", width < 660);
  }

  function setOverlay(open) {
    document.body.classList.toggle("playtest-open", open);
    backdrop.hidden = !open;
    openButton.setAttribute("aria-expanded", String(open));
    if (open) {
      // Keep the original level list interactive, including its keyboard
      // navigation. Only the covered editor controls become inert.
      for (const element of document.querySelectorAll(".app-header, .settings-panel, .all-words-panel, .preview-panel, #batch-run-bar")) {
        inertBefore.set(element, element.inert);
        element.inert = true;
      }
    } else {
      for (const [element, inert] of inertBefore) element.inert = inert;
      inertBefore.clear();
    }
  }

  function drawTrail() {
    const bounds = board.getBoundingClientRect();
    trail.setAttribute("viewBox", `0 0 ${bounds.width || 1} ${bounds.height || 1}`);
    trail.querySelector("polyline").setAttribute("points", path.map(cell => {
      const box = tiles[cell].getBoundingClientRect();
      return `${box.left - bounds.left + box.width / 2},${box.top - bounds.top + box.height / 2}`;
    }).join(" "));
  }

  function renderSelection() {
    const selected = new Set(path);
    for (const [cell, tile] of tiles.entries()) {
      tile.classList.toggle("is-selected", selected.has(cell));
      tile.setAttribute("aria-pressed", String(selected.has(cell)));
    }
    selection.textContent = path.length ? path.map(cell => state.cells[cell].letter).join("") : "连出一个单词";
    selection.classList.toggle("is-empty", !path.length);
    submit.disabled = clear.disabled = !path.length;
    drawTrail();
  }

  function renderAnswers() {
    answers.replaceChildren(...state.targets.map(word => {
      const found = state.foundTargets.includes(word);
      const item = document.createElement("li");
      item.className = `playtest-answer${found ? " is-found" : ""}`;
      const name = document.createElement("span"), mark = document.createElement("span");
      name.className = "playtest-answer-word";
      name.textContent = found || reveal.checked ? word : "·".repeat(word.length);
      name.setAttribute("aria-label", found || reveal.checked ? word : `${word.length} 个字母，尚未找到`);
      mark.className = "playtest-answer-mark";
      mark.textContent = found ? "✓" : `${word.length} 字母`;
      if (found) mark.setAttribute("aria-label", "已找到");
      item.append(name, mark);
      return item;
    }));
  }

  function render() {
    for (const [index, cell] of state.cells.entries()) {
      const tile = tiles[index];
      tile.disabled = cell.disabled || cell.count === 0;
      tile.classList.toggle("is-spent", cell.count === 0 && !cell.disabled);
      tile.querySelector(".playtest-letter").textContent = cell.count ? cell.letter : "";
      tile.querySelector(".playtest-count").textContent = cell.count ? cell.count : "";
      tile.setAttribute("aria-label", `第 ${Math.floor(index / state.columns) + 1} 行第 ${index % state.columns + 1} 列，` +
        (cell.disabled ? "禁用" : cell.count ? `${cell.letter}，剩余 ${cell.count} 次` : "已清空"));
    }
    const found = state.foundTargets.length;
    progressText.textContent = `${found} / ${state.targets.length}`;
    progress.max = state.targets.length; progress.value = found;
    document.querySelector("#playtest-extra-count").textContent = state.foundExtras.length;
    extras.textContent = state.foundExtras.length ? state.foundExtras.join(" · ") : "试着找出更多单词";
    document.querySelector("#playtest-complete").hidden = !playtestComplete(state);
    renderAnswers(); renderSelection();
  }

  function select(cell, restart = false) {
    let next = extendPlaytestPath(state, path, cell);
    if (restart && next === path && !path.includes(cell)) next = extendPlaytestPath(state, [], cell);
    if (next === path) return false;
    path = next; renderSelection(); return true;
  }

  function submitPath() {
    if (!state || !path.length) return;
    const result = submitPlaytestPath(state, path);
    state = result.state; path = [];
    feedback.textContent = result.message; feedback.dataset.kind = result.kind;
    render();
  }

  function stopPointer() {
    const active = pointer;
    pointer = null; moved = false;
    if (active !== null && board.hasPointerCapture(active)) board.releasePointerCapture(active);
  }

  function closePlaytest() {
    if (dialog.open) dialog.close();
    stopPointer(); state = initial = null; sourceKey = null; path = [];
    setOverlay(false);
    if (!openButton.disabled) openButton.focus({ preventScroll: true });
  }

  function cellAt(event) {
    const tile = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-playtest-cell]");
    return tile && board.contains(tile) && !tile.disabled ? Number(tile.dataset.playtestCell) : null;
  }

  board.addEventListener("pointerdown", event => {
    if (!state || pointer !== null || !event.isPrimary || event.button !== 0) return;
    const cell = cellAt(event);
    if (cell === null) return;
    event.preventDefault();
    tiles[cell].focus({ preventScroll: true });
    select(cell, true);
    pointer = event.pointerId; moved = false;
    board.setPointerCapture(pointer);
  });
  board.addEventListener("pointermove", event => {
    if (event.pointerId !== pointer) return;
    const cell = cellAt(event);
    if (cell !== null && select(cell)) moved = true;
  });
  board.addEventListener("pointerup", event => {
    if (event.pointerId !== pointer) return;
    const cell = cellAt(event);
    if (cell !== null && select(cell)) moved = true;
    const shouldSubmit = moved;
    stopPointer();
    if (shouldSubmit) submitPath();
  });
  board.addEventListener("pointercancel", () => { stopPointer(); path = []; renderSelection(); });
  board.addEventListener("lostpointercapture", () => {
    if (pointer !== null) { pointer = null; moved = false; path = []; renderSelection(); }
  });
  // Native keyboard activation produces a click with detail=0; pointer clicks
  // were already handled on pointerdown and must not append the cell twice.
  board.addEventListener("click", event => {
    const tile = event.target.closest("[data-playtest-cell]");
    if (state && event.detail === 0 && tile && !tile.disabled) select(Number(tile.dataset.playtestCell), true);
  });
  board.addEventListener("keydown", event => {
    const tile = event.target.closest("[data-playtest-cell]");
    if (!state || !tile || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const cell = Number(tile.dataset.playtestCell), row = Math.floor(cell / state.columns), column = cell % state.columns;
    const nextRow = row + (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0);
    const nextColumn = column + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0);
    if (nextRow >= 0 && nextRow < state.rows && nextColumn >= 0 && nextColumn < state.columns) {
      const next = tiles[nextRow * state.columns + nextColumn];
      if (!next.disabled) next.focus();
    }
  });
  submit.addEventListener("click", submitPath);
  clear.addEventListener("click", () => { stopPointer(); path = []; renderSelection(); });
  reveal.addEventListener("change", () => { if (state) renderAnswers(); });
  document.querySelector("#playtest-restart").addEventListener("click", () => {
    stopPointer(); state = structuredClone(initial); path = [];
    feedback.textContent = "已重新开始。"; feedback.dataset.kind = ""; render();
    tiles.find(tile => !tile.disabled)?.focus();
  });
  document.querySelector("#playtest-close").addEventListener("click", closePlaytest);
  dialog.addEventListener("keydown", event => event.stopPropagation());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && dialog.open && !document.querySelector("dialog:modal")) {
      event.preventDefault(); closePlaytest();
    }
  }, true);
  dialog.addEventListener("close", () => {
    if (!dialog.open && state) closePlaytest();
  });
  new ResizeObserver(() => { if (dialog.open && state) drawTrail(); }).observe(board);
  const layoutObserver = new ResizeObserver(positionPanel);
  layoutObserver.observe(levelListPanel);
  layoutObserver.observe(document.querySelector(".settings-panel"));
  window.addEventListener("resize", positionPanel);

  function loadCurrentLevel() {
    const level = getLevel();
    const next = createPlaytestState(level);
    stopPointer(); initial = next; sourceKey = levelKey(level);
    state = structuredClone(initial); path = []; reveal.checked = false;
    document.querySelector("#playtest-level-name").textContent = `${getLabel()} · ${state.rows} 行 × ${state.columns} 列`;
    feedback.textContent = "目标词扣除格子次数，额外词不扣次数。"; feedback.dataset.kind = "";
    board.style.setProperty("--playtest-columns", state.columns);
    tiles = state.cells.map((cell, index) => {
      const tile = document.createElement("button");
      tile.type = "button"; tile.className = `playtest-cell${cell.disabled ? " is-hole" : ""}`;
      tile.dataset.playtestCell = index;
      const letter = document.createElement("span"), count = document.createElement("span");
      letter.className = "playtest-letter"; count.className = "playtest-count";
      tile.append(letter, count);
      return tile;
    });
    board.replaceChildren(trail, ...tiles);
    render();
    dialog.scrollTop = 0;
  }

  openButton.addEventListener("click", () => {
    if (isBusy() || !getLevel() || dialog.open) return;
    try { loadCurrentLevel(); } catch (error) { onError(error.message); return; }
    setOverlay(true);
    dialog.show(); positionPanel(); drawTrail();
    tiles.find(tile => !tile.disabled)?.focus({ preventScroll: true });
  });

  return { refresh() {
    const level = getLevel(), busy = isBusy();
    openButton.disabled = !level?.targetWords?.length || busy;
    openButton.title = !level?.targetWords?.length ? "先生成或选择一个关卡" : busy ? "请等待当前操作完成" : "试玩当前关卡";
    if (!dialog.open || busy) return;
    if (!level?.targetWords?.length) { closePlaytest(); return; }
    try {
      if (sourceKey !== levelKey(level)) loadCurrentLevel();
      document.querySelector("#playtest-level-name").textContent = `${getLabel()} · ${state.rows} 行 × ${state.columns} 列`;
    } catch (error) { closePlaytest(); onError(error.message); }
    requestAnimationFrame(positionPanel);
  } };
}
