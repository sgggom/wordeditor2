export function svgElement(name, attributes) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

export function pathScoreBand(score) {
  return Math.min(3, score);
}

export function createPathPreview({ word, path = [], score }, { rows, columns, disabledCells = [] }) {
  const preview = svgElement("svg", {
    class: "word-path-preview",
    "data-score-band": pathScoreBand(score),
    viewBox: `0 0 ${columns * 12 + 4} ${rows * 12 + 4}`,
    "aria-hidden": "true",
    focusable: "false",
  });
  const title = svgElement("title", {});
  title.textContent = `${word} 的连接路径，难度 ${score} 分`;
  preview.append(title);
  for (let index = 0; index < rows * columns; index += 1) {
    preview.append(svgElement("rect", {
      class: disabledCells.includes(index) ? "mini-cell is-disabled" : "mini-cell",
      x: 3 + (index % columns) * 12,
      y: 3 + Math.floor(index / columns) * 12,
      width: 10,
      height: 10,
      rx: 1.5,
    }));
  }
  const points = path.map(index => ({ x: 8 + (index % columns) * 12, y: 8 + Math.floor(index / columns) * 12 }));
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
  return preview;
}
