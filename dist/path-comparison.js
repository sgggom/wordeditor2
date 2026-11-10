import { describePath } from "./level-statistics.js";
import { createPathPreview, pathScoreBand } from "./path-preview.js";
import { createPathTrend } from "./path-trend.js";
import { findPresetWordPath, normalizePresetLevels } from "./preset-level-lists.js";

const BANDS = ["绿 · 0 分", "蓝 · 1 分", "黄 · 2 分", "红 · 3 分及以上"];
const PAGE_SIZE = 25;

function groupTargetPaths(level) {
  const groups = BANDS.map(() => []);
  for (const { word, path: storedPath } of level?.targetWords ?? []) {
    const path = storedPath ?? findPresetWordPath(level, word);
    if (!path?.length) throw new Error(`目标词 ${word} 的路径无法还原。`);
    const score = describePath(path, level.columns).difficultyScore;
    groups[pathScoreBand(score)].push({ word, path, score });
  }
  return groups;
}

function renderLevel(number, sources) {
  const sides = sources.map(({ label, levels }) => {
    const level = levels[number - 1];
    return { label, level, groups: groupTargetPaths(level) };
  });
  const bands = BANDS.map((_, band) => band).filter(band => sides.some(side => side.groups[band].length));
  const table = document.createElement("table");
  table.className = "path-comparison-table";
  table.createCaption().textContent = `第 ${number} 关`;
  const header = table.createTHead().insertRow();
  for (const [label, band] of [["来源", null], ...bands.map(band => [BANDS[band], band])]) {
    const heading = document.createElement("th");
    heading.scope = "col";
    heading.textContent = label;
    if (band !== null) heading.dataset.scoreBand = String(band);
    header.append(heading);
  }
  if (!bands.length) {
    const heading = document.createElement("th");
    heading.scope = "col";
    heading.textContent = "目标路径";
    header.append(heading);
  }

  const body = table.createTBody();
  for (const { label, level, groups } of sides) {
    const row = body.insertRow();
    const heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = label;
    row.append(heading);
    if (!level || !bands.length) {
      const empty = row.insertCell();
      empty.colSpan = Math.max(1, bands.length);
      empty.textContent = level ? "无目标路径" : "无对应关卡";
      continue;
    }
    for (const band of bands) {
      const cell = row.insertCell();
      if (!groups[band].length) {
        cell.textContent = "—";
        continue;
      }
      const paths = document.createElement("div");
      paths.className = "path-comparison-paths";
      for (const entry of groups[band]) {
        const item = document.createElement("figure");
        const label = document.createElement("figcaption");
        label.textContent = entry.word;
        label.title = `路径难度 ${entry.score} 分`;
        item.append(createPathPreview(entry, level), label);
        paths.append(item);
      }
      cell.append(paths);
    }
  }
  return table;
}

async function readData(file) {
  const response = await fetch(new URL(file, new URL("./data/", import.meta.url)));
  if (!response.ok) throw new Error("读取关卡文件失败，请刷新后重试。");
  return response.json();
}

export function setupPathComparison() {
  const dialog = document.querySelector("#path-comparison-dialog");
  const list = document.querySelector("#path-comparison-list");
  const status = document.querySelector("#path-comparison-status");
  const previous = document.querySelector("#path-comparison-prev");
  const next = document.querySelector("#path-comparison-next");
  const jump = document.querySelector("#path-comparison-jump");
  const jumpInput = jump.elements.namedItem("level");
  const modes = document.querySelector("#path-comparison-modes");
  const views = document.querySelector("#path-comparison-views");
  let levelSources = [];
  let total = 0;
  let start = 0;
  let selectedLevel = 1;
  let loading = false;
  let trendChart = null;
  const hiddenTrendBands = new Set();

  function render(number = start + 1, trendOffset) {
    const end = Math.min(start + PAGE_SIZE, total);
    const mode = modes.querySelector(":checked").value;
    const trend = views.querySelector(":checked").value === "trend";
    const visibleSources = levelSources.filter(source => mode === "both" || mode === source.key);
    selectedLevel = number;
    jumpInput.value = String(number);
    previous.hidden = next.hidden = trend;
    trendChart?.dispose();
    trendChart = null;
    if (trend) {
      for (const source of visibleSources) {
        source.counts ??= source.levels.map(level => groupTargetPaths(level).map(group => group.length));
      }
      const details = document.createElement("div");
      details.className = "path-trend-details";
      trendChart = createPathTrend(visibleSources, BANDS, total, number, hiddenTrendBands, level => {
        details.replaceChildren(renderLevel(level, visibleSources));
      });
      list.replaceChildren(trendChart.figure, details);
      trendChart.mount(trendOffset);
      list.scrollTop = 0;
      status.textContent = `第 1–${total} 关 · 逐关计数`;
    } else {
      const page = document.createDocumentFragment();
      for (let index = start; index < end; index += 1) {
        page.append(renderLevel(index + 1, visibleSources));
      }
      list.replaceChildren(page);
      list.children[number - 1 - start].scrollIntoView({ block: "start", inline: "nearest" });
      previous.disabled = start === 0;
      next.disabled = end === total;
      status.textContent = `第 ${start + 1}–${end} 关 / 共 ${total} 关`;
    }
  }

  document.querySelector("#open-path-comparison").addEventListener("click", async () => {
    dialog.showModal();
    if (loading || total) return;
    loading = true;
    status.textContent = "正在读取关卡…";
    try {
      const index = await readData("preset-level-lists.json");
      const ours = index.presets.find(preset => preset.id === "our-levels-three-letter-pruned-2000-2026-11-05");
      const reference = index.referenceLists.find(preset => preset.id === "word-tiles-list0");
      if (!ours || !reference) throw new Error("找不到用于对比的本地预设。");
      const [ourLevels, referenceLevels] = await Promise.all([ours, reference].map(async preset =>
        normalizePresetLevels(await readData(preset.file), preset.format)));
      levelSources = [
        { key: "ours", label: "我们的", levels: ourLevels },
        { key: "theirs", label: "Word Tiles", levels: referenceLevels },
      ];
      total = Math.max(ourLevels.length, referenceLevels.length);
      render();
      jumpInput.max = String(total);
      jumpInput.disabled = false;
      jump.querySelector("button").disabled = false;
    } catch (error) {
      total = 0;
      status.textContent = error.message || "无法加载目标路径对比。";
    } finally {
      loading = false;
    }
  });
  document.querySelector("#close-path-comparison").addEventListener("click", () => dialog.close());
  previous.addEventListener("click", () => { start = Math.max(0, start - PAGE_SIZE); render(); });
  next.addEventListener("click", () => { start += PAGE_SIZE; render(); });
  function changeView() {
    if (!total) return;
    if (trendChart) {
      render(selectedLevel, trendChart.offset());
      return;
    }
    const top = list.getBoundingClientRect().top;
    const index = [...list.children].findIndex(table => table.getBoundingClientRect().bottom > top);
    render(start + Math.max(0, index) + 1);
  }
  modes.addEventListener("change", changeView);
  views.addEventListener("change", changeView);
  jump.addEventListener("submit", event => {
    event.preventDefault();
    const number = jumpInput.valueAsNumber;
    if (!Number.isInteger(number) || number < 1 || number > total) return;
    start = Math.floor((number - 1) / PAGE_SIZE) * PAGE_SIZE;
    render(number);
  });
}
