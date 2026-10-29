const bindings = new WeakMap();
const focusBindings = new WeakMap();
const emotionLabels = { "-2": "恶性情绪", "-1": "负面情绪", 0: "中性情绪", 1: "正面情绪", 2: "积极情绪" };
let sourcesPromise;
let dictionaryPromise;
let initialized = false;

async function readData(file) {
  const response = await fetch(new URL(`./data/${file}`, import.meta.url));
  if (!response.ok) throw new Error("单词资料加载失败");
  return response.json();
}

function loadSources() {
  sourcesPromise ??= readData("word-game-sources.json").catch(error => { sourcesPromise = null; throw error; });
  return sourcesPromise;
}

function loadDictionary() {
  dictionaryPromise ??= Promise.all(["required-words.json", "guide-words.json", "extra-words.json"].map(readData))
    .then(groups => new Map(groups.flatMap((group, index) => group.map(entry => [entry.word, { ...entry, onlyExtra: index === 2 }]))))
    .catch(error => { dictionaryPromise = null; throw error; });
  return dictionaryPromise;
}

export function sourceGamesForWord(sources, word) {
  const key = String(word).trim().toUpperCase();
  const mask = Object.hasOwn(sources?.entries ?? {}, key) ? sources.entries[key] : 0;
  return (sources?.games ?? []).filter((_, index) => mask & (1 << index));
}

export function wordTooltipDetails(word, entry) {
  const value = number => Number.isInteger(number) ? String(number) : "未填写";
  const brief = (text, limit, fallback) => typeof text === "string" && text.trim()
    ? text.trim().slice(0, limit).trimEnd() + (text.trim().length > limit ? "…" : "") : fallback;
  return {
    word: String(word).trim().toUpperCase(),
    fields: entry ? [
      ["所属词库", entry.onlyExtra ? "仅额外词库" : entry.scope === 0 ? "2词库" : "普通词库"],
      ["范围库", entry.scope === 0 ? "2词库" : value(entry.scope)],
      ["情绪类型", Object.hasOwn(emotionLabels, entry.emotion) ? `${emotionLabels[entry.emotion]}（${entry.emotion}）` : "未填写"],
      ["是否缩写", entry.abbreviation === 0 ? "否（0）" : entry.abbreviation === 1 ? "是（1）" : "未填写"],
      ["生僻档位", Number.isInteger(entry.rarityLevel) ? `${entry.rarityLevel} 档` : "未填写"],
    ] : [],
    phonetic: brief(entry?.phonetic, 120, "暂无音标"),
    definitionZh: brief(entry?.definitionZh, 180, "暂无中文释义"),
    definitionEn: brief(entry?.definitionEn, 480, "暂无英文释义"),
  };
}

// Keep the hovered word separate from its enclosing action, so hovering a path
// diagram does not open a word card and keyboard users can focus the action.
export function bindWordTooltip(element, entry, focusTarget = element) {
  element.dataset.tooltipWord = entry.word;
  const binding = { element, entry, focusTarget };
  bindings.set(element, binding);
  focusBindings.set(focusTarget, binding);
  if (focusTarget === element && !element.matches("button, a, input, [tabindex]")) element.tabIndex = 0;
}

export function setupWordTooltips() {
  if (initialized) return;
  initialized = true;
  const tip = document.createElement("aside");
  tip.id = "word-tooltip";
  tip.className = "word-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("popover", "manual");
  tip.hidden = true;
  document.body.append(tip);
  let current = null;
  let timer;
  let revision = 0;
  let describedElement;

  function clearDescription() {
    if (!describedElement) return;
    const ids = (describedElement.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(id => id && id !== tip.id);
    if (ids.length) describedElement.setAttribute("aria-describedby", ids.join(" "));
    else describedElement.removeAttribute("aria-describedby");
    describedElement = null;
  }

  function hide() {
    revision++;
    clearTimeout(timer);
    current = null;
    clearDescription();
    if (tip.matches(":popover-open")) tip.hidePopover();
    tip.hidden = true;
  }

  function visible(binding, token) {
    return token === revision && current === binding && binding.element.isConnected && binding.element.getClientRects().length > 0;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function place(binding) {
    const parent = binding.element.closest("dialog[open]") ?? document.body;
    if (tip.parentElement !== parent) {
      if (tip.matches(":popover-open")) tip.hidePopover();
      parent.append(tip);
    }
    tip.hidden = false;
    if (!tip.matches(":popover-open")) tip.showPopover();
    const rect = binding.element.getBoundingClientRect();
    const margin = 8, width = tip.offsetWidth, height = tip.offsetHeight;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - margin) top = rect.top - height - 6;
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    clearDescription();
    describedElement = binding.focusTarget;
    const ids = new Set((describedElement.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    ids.add(tip.id);
    describedElement.setAttribute("aria-describedby", [...ids].join(" "));
  }

  function render(binding, entry, sources, sourceStatus) {
    const details = wordTooltipDetails(binding.entry.word, entry);
    const heading = node("div", "word-tooltip-heading");
    heading.append(node("strong", "", details.word), node("span", "word-tooltip-phonetic", details.phonetic));
    const sourceBlock = node("section", "word-tooltip-sources");
    sourceBlock.setAttribute("aria-label", "来源游戏");
    sourceBlock.append(node("span", "word-tooltip-label", "来源游戏"));
    const games = sourceGamesForWord(sources, details.word);
    const chips = node("div", "word-tooltip-games");
    for (const game of games) {
      const chip = node("span", "word-tooltip-game", game.name);
      chip.dataset.sourceGame = game.id;
      if (/^#[\da-f]{6}$/i.test(game.color)) chip.style.setProperty("--game-color", game.color);
      chips.append(chip);
    }
    if (!games.length) chips.append(node("span", "word-tooltip-note", sourceStatus ?? "参考项目暂无记录"));
    sourceBlock.append(chips);
    const fields = node("dl", "word-tooltip-fields");
    for (const [label, value] of details.fields) {
      const field = node("div", "");
      field.append(node("dt", "", label), node("dd", "", value));
      fields.append(field);
    }
    const definitions = node("dl", "word-tooltip-definitions");
    definitions.append(node("dt", "", "中文"), node("dd", "word-tooltip-zh", details.definitionZh),
      node("dt", "", "English"), node("dd", "word-tooltip-en", details.definitionEn));
    tip.replaceChildren(heading, sourceBlock, fields, definitions);
    if (!entry) fields.append(node("p", "word-tooltip-note", sourceStatus === "加载中…" ? "词库参数加载中…" : "当前词库未收录参数"));
    place(binding);
  }

  function schedule(binding) {
    if (!binding || binding === current) return;
    hide();
    current = binding;
    const token = revision;
    timer = setTimeout(async () => {
      if (!visible(binding, token)) return;
      const hasDetails = ["scope", "phonetic", "emotion", "abbreviation", "rarityLevel", "definitionZh", "definitionEn"]
        .every(key => Object.hasOwn(binding.entry, key));
      const supplied = hasDetails ? binding.entry : null;
      render(binding, supplied, null, "加载中…");
      const [sources, record] = await Promise.allSettled([
        loadSources(),
        hasDetails ? supplied : loadDictionary().then(dictionary => dictionary.get(binding.entry.word) ?? null),
      ]);
      if (!visible(binding, token)) return;
      render(binding, record.status === "fulfilled" ? record.value : supplied,
        sources.status === "fulfilled" ? sources.value : null,
        sources.status === "rejected" ? "来源游戏暂时无法加载" : null);
    }, 150);
  }

  function hit(target) {
    return bindings.get(target instanceof Element ? target.closest("[data-tooltip-word]") : null);
  }
  document.addEventListener("mouseover", event => schedule(hit(event.target)));
  document.addEventListener("mouseout", event => {
    const binding = hit(event.target);
    if (binding === current && !(event.relatedTarget instanceof Node && binding.element.contains(event.relatedTarget))) hide();
  });
  document.addEventListener("focusin", event => schedule(focusBindings.get(event.target)));
  document.addEventListener("focusout", event => { if (focusBindings.get(event.target) === current) hide(); });
  document.addEventListener("scroll", () => { if (current) hide(); }, true);
  document.addEventListener("close", hide, true);
  document.addEventListener("cancel", hide, true);
  document.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
  window.addEventListener("resize", hide);
  new MutationObserver(() => { if (current && !current.element.isConnected) hide(); })
    .observe(document.body, { childList: true, subtree: true });
}
