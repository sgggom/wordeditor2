(() => {
  "use strict";

  const DEFAULT_SIZE = Object.freeze({ rows: 3, columns: 4 });
  const LIMITS = Object.freeze({ rows: [2, 3], columns: [3, 5] });
  const STORAGE_KEY = "fangge.level-size.v1";
  const form = document.querySelector("#size-form");
  const board = document.querySelector("#board");
  const layout = document.querySelector("#board-layout");
  const rowLabels = document.querySelector("#row-labels");
  const columnLabels = document.querySelector("#column-labels");
  const summary = document.querySelector("#size-summary");
  const count = document.querySelector("#cell-count");
  const footnote = document.querySelector("#board-footnote");
  const resetButton = document.querySelector("#reset-size");
  const storageNote = document.querySelector("#storage-note");

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
      storageNote.textContent = "修改即生效，尺寸自动保存在本机。";
    } catch {
      storageNote.textContent = "修改即生效；当前浏览器无法保存尺寸。";
    }
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

  function render() {
    const { rows, columns } = size;
    layout.style.setProperty("--rows", rows);
    layout.style.setProperty("--columns", columns);
    rowLabels.replaceChildren(makeLabels(rows));
    columnLabels.replaceChildren(makeLabels(columns));

    const fragment = document.createDocumentFragment();
    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      const row = document.createElement("div");
      row.className = "board-row";
      row.setAttribute("role", "row");
      for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
        const cell = document.createElement("div");
        cell.className = `board-cell${(rowIndex + columnIndex) % 2 === 1 ? " alternate" : ""}`;
        cell.setAttribute("role", "cell");
        cell.setAttribute("aria-label", `第 ${rowIndex + 1} 行，第 ${columnIndex + 1} 列，空白`);
        cell.dataset.row = String(rowIndex + 1);
        cell.dataset.column = String(columnIndex + 1);
        row.append(cell);
      }
      fragment.append(row);
    }
    board.replaceChildren(fragment);
    board.setAttribute("aria-rowcount", String(rows));
    board.setAttribute("aria-colcount", String(columns));
    board.setAttribute("aria-label", `空白棋盘，${rows} 行 ${columns} 列`);

    form.elements.namedItem("rows").value = String(rows);
    form.elements.namedItem("columns").value = String(columns);
    summary.textContent = `${rows} 行 × ${columns} 列`;
    count.textContent = String(rows * columns);
    footnote.textContent = `${rows * columns} 个格子，等待你的创意`;
    resetButton.disabled = rows === DEFAULT_SIZE.rows && columns === DEFAULT_SIZE.columns;
    saveSize();
  }

  let size = readSize();

  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLInputElement) || !(event.target.name in LIMITS)) return;
    const nextSize = { ...size, [event.target.name]: Number(event.target.value) };
    if (!isValidSize(nextSize)) return;
    size = nextSize;
    render();
  });

  resetButton.addEventListener("click", () => {
    size = { ...DEFAULT_SIZE };
    render();
  });

  render();
})();
