const bindings = new WeakMap();
const focusBindings = new WeakMap();
const emotionLabels = { "-2": "恶性情绪", "-1": "负面情绪", 0: "中性情绪", 1: "正面情绪", 2: "积极情绪" };
let sourcesPromise;
let dictionaryPromise;
const levelSourceLoads = new Map();
const sourceRoleLabels = ["目标词", "额外词", "仅额外", "奖励词"];
const detailedSourceGames = new Set(["06_Zen_Word"]);
const detailedSourceVersions = new Set(["t1", "t3"]);
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

function loadLevelSources(sources, word) {
  const first = word.trim().toUpperCase()[0];
  const key = /^[A-Z]$/.test(first) ? first.toLowerCase() : "other";
  const file = sources.provenance?.files[key];
  if (!file) return Promise.resolve({ datasetHash: sources.source.datasetHash, entries: {} });
  const cacheKey = `${file.file}:${file.sha256}`;
  if (levelSourceLoads.has(cacheKey)) {
    const cached = levelSourceLoads.get(cacheKey);
    levelSourceLoads.delete(cacheKey); levelSourceLoads.set(cacheKey, cached);
    return cached;
  }
  if (!levelSourceLoads.has(cacheKey)) {
    const promise = (async () => {
      const response = await fetch(new URL(`./data/${sources.provenance.directory}/${file.file}`, import.meta.url));
      if (!response.ok) throw new Error("来源关卡加载失败");
      const stream = new Blob([await response.arrayBuffer()]).stream().pipeThrough(new DecompressionStream("gzip"));
      return JSON.parse(await new Response(stream).text());
    })().catch(error => { if (levelSourceLoads.get(cacheKey) === promise) levelSourceLoads.delete(cacheKey); throw error; });
    levelSourceLoads.set(cacheKey, promise);
    // Keep a few recent letters warm without retaining every game's full
    // provenance in memory as the user browses different words.
    while (levelSourceLoads.size > 4) levelSourceLoads.delete(levelSourceLoads.keys().next().value);
  }
  return levelSourceLoads.get(cacheKey);
}

export function sourceGamesForWord(sources, word) {
  const key = String(word).trim().toUpperCase();
  const mask = Object.hasOwn(sources?.entries ?? {}, key) ? sources.entries[key] : 0;
  return (sources?.games ?? []).filter((_, index) => mask & (1 << index));
}

export function sourceLevelsForWord(sources, shard, word) {
  if (shard.datasetHash !== sources.source.datasetHash) throw new Error("来源关卡版本不一致，请刷新页面。");
  const key = String(word).trim().toUpperCase();
  const entries = Object.hasOwn(shard.entries, key) ? shard.entries[key] : [];
  const games = new Map();
  for (const [gameIndex, configIndex, locations] of entries) {
    const game = sources.games[gameIndex];
    if (!detailedSourceGames.has(game?.id)) continue;
    const config = game.configs?.[configIndex];
    if (!config) throw new Error("来源关卡版本无效。");
    if (!detailedSourceVersions.has(config.id)) continue;
    if (!games.has(game.id)) games.set(game.id, { ...game, configs: [] });
    games.get(game.id).configs.push({ ...config, locations: locations.map(([number, id, roleMask, shard]) => ({
      number, id, shard,
      label: config.levelKind === "sharded" ? `分片 ${shard} · 序号 ${number}` : number === null ? `未映射关卡（ID ${id}）` : `第 ${number} 关`,
      roles: sourceRoleLabels.filter((_, index) => roleMask & (1 << index)),
    })) });
  }
  return [...games.values()];
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
  tip.setAttribute("role", "dialog");
  tip.setAttribute("aria-label", "单词信息与来源关卡");
  tip.setAttribute("popover", "manual");
  tip.hidden = true;
  document.body.append(tip);
  let current = null;
  let timer;
  let closeTimer;
  let restoringFocus = false;
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
    clearTimeout(closeTimer);
    current = null;
    clearDescription();
    if (tip.matches(":popover-open")) tip.hidePopover();
    tip.hidden = true;
  }

  function deferHide() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(hide, 220);
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
    let left, top;
    if (rect.right + 10 + width <= window.innerWidth - margin) { left = rect.right + 10; top = rect.top; }
    else if (rect.left - width - 10 >= margin) { left = rect.left - width - 10; top = rect.top; }
    else {
      left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      top = rect.bottom + 6;
      if (top + height > window.innerHeight - margin) top = rect.top - height - 6;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    clearDescription();
    describedElement = binding.focusTarget;
    const ids = new Set((describedElement.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    ids.add(tip.id);
    describedElement.setAttribute("aria-describedby", [...ids].join(" "));
  }

  function renderSources(block, sources, word, groups = null, status = null) {
    block.replaceChildren(node("h3", "word-tooltip-sources-title", "来源游戏与关卡"));
    const games = sourceGamesForWord(sources, word);
    if (!games.length) {
      block.append(node("p", "word-tooltip-note", status ?? "参考项目暂无记录"));
      return;
    }
    function locationRow(location) {
      const row = node("li", "word-source-level");
      row.dataset.sourceLevel = location.number === null ? "unmapped" : String(location.number);
      row.dataset.sourceId = String(location.id);
      if (location.shard !== undefined) row.dataset.sourceShard = String(location.shard);
      row.title = `原始 ID：${location.id}`;
      row.append(node("span", "word-source-number", location.label), node("span", "word-source-role", location.roles.join(" / ")));
      return row;
    }
    function gameChip(game) {
      const chip = node("span", "word-tooltip-game", game.name);
      chip.dataset.sourceGame = game.id;
      if (/^#[\da-f]{6}$/i.test(game.color)) chip.style.setProperty("--game-color", game.color);
      return chip;
    }
    for (const game of games.filter(game => detailedSourceGames.has(game.id))) {
      const section = node("section", "word-source-game");
      const heading = node("div", "word-source-heading");
      const chip = gameChip(game);
      heading.append(chip); section.append(heading);
      const configs = groups?.find(group => group.id === game.id)?.configs;
      if (configs?.length) {
        heading.append(node("span", "word-source-count", `${configs.reduce((sum, config) => sum + config.locations.length, 0)} 处`));
        for (const config of configs) {
          const version = node("section", "word-source-version");
          version.dataset.sourceConfig = config.id;
          const label = node("h4", "", `${config.label} · ${config.locations.length} 处`);
          if (config.sourceAliases?.length) label.title = `相同资源副本：${config.sourceAliases.join("、")}`;
          const list = node("ol", "word-source-levels word-source-preview");
          list.append(...config.locations.slice(0, 3).map(locationRow));
          version.append(label, list);
          if (config.locations.length > 3) {
            const more = node("details", "word-source-more");
            more.append(node("summary", "", `展开其余 ${config.locations.length - 3} 处`));
            let filled = false;
            more.addEventListener("toggle", () => {
              if (!more.open || filled) return;
              filled = true;
              const rest = node("ol", "word-source-levels");
              rest.append(...config.locations.slice(3).map(locationRow)); more.append(rest);
            });
            version.append(more);
          }
          section.append(version);
        }
      } else section.append(node("p", "word-tooltip-note", status ?? (groups ? "t1 / t3 暂无来源关卡记录" : "来源关卡加载中…")));
      block.append(section);
    }
    const others = games.filter(game => !detailedSourceGames.has(game.id));
    if (others.length) {
      const summary = node("section", "word-source-other-games");
      summary.append(node("h4", "", "其他来源游戏"));
      const chips = node("div", "word-tooltip-games");
      chips.append(...others.map(gameChip)); summary.append(chips); block.append(summary);
    }
  }

  function render(binding, entry, sources, sourceStatus) {
    const details = wordTooltipDetails(binding.entry.word, entry);
    const info = node("section", "word-tooltip-info");
    info.setAttribute("aria-label", "单词信息"); info.tabIndex = 0;
    const heading = node("div", "word-tooltip-heading");
    heading.append(node("strong", "", details.word), node("span", "word-tooltip-phonetic", details.phonetic));
    const sourceBlock = node("section", "word-tooltip-sources");
    sourceBlock.setAttribute("aria-label", "来源游戏与关卡"); sourceBlock.tabIndex = 0;
    renderSources(sourceBlock, sources, details.word, null, sourceStatus);
    const fields = node("dl", "word-tooltip-fields");
    for (const [label, value] of details.fields) {
      const field = node("div", "");
      field.append(node("dt", "", label), node("dd", "", value)); fields.append(field);
    }
    const definitions = node("dl", "word-tooltip-definitions");
    definitions.append(node("dt", "", "中文"), node("dd", "word-tooltip-zh", details.definitionZh),
      node("dt", "", "English"), node("dd", "word-tooltip-en", details.definitionEn));
    info.append(heading, fields, definitions);
    if (!entry) fields.append(node("p", "word-tooltip-note", sourceStatus === "加载中…" ? "词库参数加载中…" : "当前词库未收录参数"));
    tip.replaceChildren(info, sourceBlock);
    place(binding);
    return sourceBlock;
  }

  function schedule(binding) {
    if (!binding) return;
    clearTimeout(closeTimer);
    if (binding === current) return;
    hide(); current = binding;
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
      const sourceData = sources.status === "fulfilled" ? sources.value : null;
      const sourceBlock = render(binding, record.status === "fulfilled" ? record.value : supplied, sourceData,
        sources.status === "rejected" ? "来源游戏暂时无法加载" : null);
      if (!sourceGamesForWord(sourceData, binding.entry.word).some(game => detailedSourceGames.has(game.id))) return;
      try {
        const shard = await loadLevelSources(sourceData, binding.entry.word);
        if (!visible(binding, token)) return;
        renderSources(sourceBlock, sourceData, binding.entry.word, sourceLevelsForWord(sourceData, shard, binding.entry.word));
      } catch {
        if (!visible(binding, token)) return;
        renderSources(sourceBlock, sourceData, binding.entry.word, null, "来源关卡暂时无法加载，请移开后重试");
      }
      place(binding);
    }, 150);
  }

  function hit(target) {
    return bindings.get(target instanceof Element ? target.closest("[data-tooltip-word]") : null);
  }
  document.addEventListener("mouseover", event => schedule(hit(event.target)));
  document.addEventListener("mouseout", event => {
    const binding = hit(event.target);
    const to = event.relatedTarget;
    if (binding === current && !(to instanceof Node && (binding.element.contains(to) || tip.contains(to)))) deferHide();
  });
  tip.addEventListener("mouseenter", () => clearTimeout(closeTimer));
  tip.addEventListener("mouseleave", event => {
    if (tip.contains(document.activeElement)) return;
    if (!(event.relatedTarget instanceof Node && current?.element.contains(event.relatedTarget))) deferHide();
  });
  document.addEventListener("focusin", event => {
    if (tip.contains(event.target)) { clearTimeout(closeTimer); return; }
    if (!restoringFocus) schedule(focusBindings.get(event.target));
  });
  document.addEventListener("focusout", event => {
    if (focusBindings.get(event.target) !== current && !tip.contains(event.target)) return;
    if (!(event.relatedTarget instanceof Node && (tip.contains(event.relatedTarget) || event.relatedTarget === current?.focusTarget))) deferHide();
  });
  document.addEventListener("scroll", event => { if (current && !tip.contains(event.target)) hide(); }, true);
  tip.addEventListener("toggle", event => {
    if (!(event.target instanceof HTMLDetailsElement)) return;
    requestAnimationFrame(() => { if (current && tip.matches(":popover-open")) place(current); });
  }, true);
  document.addEventListener("close", hide, true);
  document.addEventListener("cancel", hide, true);
  document.addEventListener("keydown", event => {
    if (!current) return;
    if (event.key === "ArrowRight" && event.target === current.focusTarget && tip.matches(":popover-open")) {
      event.preventDefault(); tip.querySelector(".word-tooltip-sources")?.focus({ preventScroll: true });
    }
    if (event.key === "Escape") {
      event.preventDefault();
      const target = tip.contains(document.activeElement) ? current.focusTarget : null;
      hide();
      if (target?.isConnected) { restoringFocus = true; target.focus({ preventScroll: true }); restoringFocus = false; }
    }
  });
  window.addEventListener("resize", hide);
  new MutationObserver(() => { if (current && !current.element.isConnected) hide(); })
    .observe(document.body, { childList: true, subtree: true });
}
