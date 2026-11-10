import { svgElement } from "./path-preview.js";

const LEVELS_PER_SCREEN = 20;
const HEIGHT = 288;
const LEFT = 64;
const TOP = 28;
const BOTTOM = HEIGHT - 32;

export function createPathTrend(sources, bands, total, selectedLevel, hiddenBands, onLevelChange) {
  let spacing = 0;
  let displayedLevel = null;
  const x = level => LEFT + (level - 1) * spacing;
  const figure = document.createElement("figure");
  figure.className = "path-trend";
  const legend = document.createElement("figcaption");
  legend.className = "path-trend-legend";
  const bandLines = bands.map(() => []);
  for (const [band, label] of bands.entries()) {
    const item = document.createElement("button");
    item.type = "button";
    item.dataset.scoreBand = String(band);
    item.textContent = label;
    item.setAttribute("aria-pressed", String(!hiddenBands.has(band)));
    item.addEventListener("click", () => {
      const hide = !hiddenBands.has(band);
      if (hide) hiddenBands.add(band);
      else hiddenBands.delete(band);
      item.setAttribute("aria-pressed", String(!hide));
      for (const line of bandLines[band]) line.toggleAttribute("hidden", hide);
    });
    legend.append(item);
  }
  for (const { key, label } of sources) {
    const item = document.createElement("span");
    item.dataset.source = key;
    item.textContent = `${label} · ${key === "theirs" ? "虚线" : "实线"}`;
    legend.append(item);
  }

  const viewport = document.createElement("div");
  viewport.className = "path-trend-scroll";
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "region");
  viewport.setAttribute("aria-label", "左右滚动查看关卡趋势");
  const chart = svgElement("svg", {
    role: "img",
    "aria-label": "逐关目标路径数量趋势图。横轴为关卡号，纵轴为目标词数量。",
  });
  viewport.append(chart);
  const plot = svgElement("g", {});
  const axis = svgElement("g", { class: "path-trend-axis" });
  axis.append(svgElement("rect", { width: LEFT - 1, height: HEIGHT, fill: "#fff" }));
  const maximum = Math.max(1, ...sources.map(({ counts }) =>
    counts.reduce((max, level) => Math.max(max, ...level), 0)));
  const yStep = Math.max(1, Math.ceil(maximum / 6));
  const yMax = Math.ceil(maximum / yStep) * yStep;
  const y = count => BOTTOM - count / yMax * (BOTTOM - TOP);
  function text(parent, label, attributes) {
    const element = svgElement("text", attributes);
    element.textContent = label;
    parent.append(element);
    return element;
  }
  const grid = [];
  for (let count = 0; count <= yMax; count += yStep) {
    const height = y(count);
    const line = svgElement("line", { class: "path-trend-grid", x1: LEFT, y1: height, y2: height });
    grid.push(line);
    chart.append(line);
    text(axis, count, { x: LEFT - 9, y: height + 4, "text-anchor": "end" });
  }
  const ticks = [1];
  for (let level = 5; level <= total; level += 5) ticks.push(level);
  const tickLabels = ticks.map(level => text(chart, level, {
    y: BOTTOM + 20,
    "text-anchor": level === 1 ? "start" : level === total ? "end" : "middle",
  }));
  text(axis, "目标词数量", { x: LEFT - 4, y: 17, "text-anchor": "end" });
  axis.append(svgElement("line", { class: "path-trend-grid", x1: LEFT - 1, x2: LEFT - 1, y1: TOP, y2: BOTTOM }));

  const series = [];
  for (const { key, counts } of sources) {
    for (const band of bands.keys()) {
      const line = svgElement("polyline", {
        class: "path-trend-line",
        "data-score-band": band,
        "data-source": key,
      });
      series.push({ line, heights: counts.map(level => y(level[band]).toFixed(2)) });
      bandLines[band].push(line);
      line.toggleAttribute("hidden", hiddenBands.has(band));
      plot.append(line);
    }
  }
  const marker = svgElement("line", { class: "path-trend-marker", y1: TOP, y2: BOTTOM });
  chart.append(plot, marker, axis);
  function positionAxis() {
    axis.setAttribute("transform", `translate(${viewport.scrollLeft} 0)`);
  }
  viewport.addEventListener("scroll", positionAxis);

  function showLevel(level) {
    const location = x(level);
    marker.setAttribute("x1", location);
    marker.setAttribute("x2", location);
    if (displayedLevel === level) return;
    displayedLevel = level;
    onLevelChange(level);
  }
  chart.addEventListener("pointermove", event => {
    if (!spacing || event.clientX - viewport.getBoundingClientRect().left < LEFT) return;
    const chartX = event.clientX - chart.getBoundingClientRect().left;
    showLevel(Math.min(total, Math.max(1, 1 + Math.round((chartX - LEFT) / spacing))));
  });
  figure.append(legend, viewport);
  function offset() {
    return spacing ? viewport.scrollLeft / spacing : undefined;
  }
  function resize(levelOffset = offset()) {
    const nextSpacing = (viewport.clientWidth - LEFT) / LEVELS_PER_SCREEN;
    if (nextSpacing <= 0 || nextSpacing === spacing) return;
    spacing = nextSpacing;
    const width = LEFT + total * spacing;
    chart.setAttribute("viewBox", `0 0 ${width} ${HEIGHT}`);
    chart.style.width = `${width}px`;
    grid.forEach(line => line.setAttribute("x2", width));
    tickLabels.forEach((label, index) => label.setAttribute("x", x(ticks[index])));
    for (const { line, heights } of series) {
      line.setAttribute("points", heights.map((height, index) => `${x(index + 1).toFixed(2)},${height}`).join(" "));
    }
    viewport.scrollLeft = (levelOffset ?? selectedLevel - 1 - LEVELS_PER_SCREEN / 2) * spacing;
    positionAxis();
    showLevel(displayedLevel ?? selectedLevel);
  }
  const observer = new ResizeObserver(() => resize());
  return {
    figure,
    offset,
    mount(levelOffset) {
      resize(levelOffset);
      observer.observe(viewport);
    },
    dispose() { observer.disconnect(); },
  };
}
