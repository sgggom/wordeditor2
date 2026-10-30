export function virtualListRange(offsets, scrollTop, viewportHeight, overscan = 4) {
  const count = offsets.length - 1;
  if (!count) return { start: 0, end: 0 };
  function indexAt(position) {
    let low = 0, high = count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (offsets[middle + 1] <= position) low = middle + 1;
      else high = middle;
    }
    return Math.min(count - 1, low);
  }
  return { start: Math.max(0, indexAt(scrollTop) - overscan),
    end: Math.min(count, indexAt(scrollTop + Math.max(1, viewportHeight) - .001) + 1 + overscan) };
}

export function createVirtualList(container, { renderItem, itemSize }) {
  let items = [], offsets = [0], start = -1, end = -1, frame = null;
  const nodes = new Map();
  const top = document.createElement("div"), bottom = document.createElement("div");
  for (const spacer of [top, bottom]) {
    spacer.className = "fixed-search-spacer";
    spacer.setAttribute("aria-hidden", "true");
  }
  container.setAttribute("role", "list");
  function render(scrollTop = container.scrollTop, force = false) {
    const range = virtualListRange(offsets, scrollTop, container.clientHeight || 400);
    if (!force && range.start === start && range.end === end) return;
    start = range.start; end = range.end;
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    for (const index of nodes.keys()) if (index < start || index >= end) nodes.delete(index);
    const fragment = document.createDocumentFragment();
    top.style.height = `${offsets[start]}px`;
    bottom.style.height = `${offsets[items.length] - offsets[end]}px`;
    fragment.append(top);
    for (let index = start; index < end; index++) {
      if (!nodes.has(index)) {
        const node = renderItem(items[index]);
        node.setAttribute("role", "listitem");
        node.setAttribute("aria-posinset", String(index + 1));
        node.setAttribute("aria-setsize", String(items.length));
        nodes.set(index, node);
      }
      fragment.append(nodes.get(index));
    }
    fragment.append(bottom);
    container.replaceChildren(fragment);
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }
  function schedule() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; render(); });
  }
  function moveTo(position) {
    const target = Math.max(0, Math.min(position, offsets[items.length] - container.clientHeight));
    render(target, true);
    container.scrollTop = target;
  }
  const resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(container);
  container.addEventListener("scroll", schedule, { passive: true });
  return {
    setItems(next, { resetScroll = false } = {}) {
      const position = resetScroll ? 0 : container.scrollTop;
      items = next;
      offsets = [0];
      for (const item of items) offsets.push(offsets.at(-1) + itemSize(item));
      nodes.clear();
      moveTo(position);
    },
    scrollToIndex(index) {
      if (Number.isInteger(index) && index >= 0 && index < items.length) moveTo(offsets[index]);
    },
    destroy() {
      if (frame !== null) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      container.removeEventListener("scroll", schedule);
      nodes.clear();
    },
  };
}
