import { importGameLevels } from "./level-import.js";
import { bindWordTooltip } from "./word-tooltip.js";

export function createPresetRecords(data, format, dictionary = []) {
  if (format !== "word-tiles") return structuredClone(data.records).map((record, index) => ({ ...record, id: -index - 1 }));
  const sources = normalizePresetLevels(data, format).map(level => {
    const counts = Array(level.letters.length).fill(0);
    for (const entry of level.targetWords) {
      const path = findPresetWordPath(level, entry.word);
      if (!path) throw new Error(`${entry.word} 无法在参考棋盘中连接。`);
      for (const cell of path) counts[cell]++;
    }
    return { g: Array.from({ length: level.rows }, (_, row) => level.letters.slice(row * level.columns, (row + 1) * level.columns).join("")).join(","),
      t: level.targetWords.map(entry => entry.word).join(" "), e: level.extraWords.map(entry => entry.word).join(" "),
      n: counts.map(count => count.toString(36)).join("") };
  });
  return importGameLevels({ books: [{ levels: sources }], daily: [] }, dictionary).map((level, index) => ({ id: -index - 1, sourceId: data[index].id, level }));
}

export function normalizePresetLevels(data, format) {
  const levels = format === "word-tiles" ? data : data?.records?.map(record => record.level);
  if (!Array.isArray(levels) || (!levels.length && format === "word-tiles")) throw new Error("预设关卡列表为空。");
  return levels.map((level, index) => {
    const reference = format === "word-tiles";
    const rows = reference ? level.height : level.rows;
    const columns = reference ? level.width : level.columns;
    let letters = reference ? [...level.letters.replaceAll(",", "")] : level.cells.map(cell => cell.letter);
    const targetWords = (reference ? level.target_words : level.targetWords).map(entry => ({ ...entry }));
    const extraWords = (reference ? level.extra_words : level.extraWords).map(entry => ({ ...entry }));
    const disabledCells = reference ? [] : level.disabledCells ?? level.cells.flatMap((cell, index) => cell.disabled ? [index] : []);
    if (![2, 3, 4, 5].includes(rows) || ![2, 3, 4, 5].includes(columns) || letters.length !== rows * columns ||
        letters.some((letter, index) => disabledCells.includes(index) ? letter !== "" : !/^[A-Z]$/.test(letter)) || !targetWords.length ||
        [...targetWords, ...extraWords].some(entry => !/^[A-Z]+$/.test(entry.word))) {
      throw new Error(`第 ${index + 1} 关数据无效。`);
    }
    // Reference rows run bottom to top; editor cell indices run top to bottom.
    if (reference) letters = Array.from({ length: rows }, (_, row) =>
      letters.slice((rows - row - 1) * columns, (rows - row) * columns)).flat();
    return { rows, columns, letters, disabledCells, targetWords, extraWords, sourceId: reference ? level.id : data.records[index].sourceId ?? null };
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

export function setupPresetLevelLists({ getView, getFiles, onSelect, onBrowser, onFile, onOpenFile, onSaveFile, onLevelSelect }) {
  const dialog = document.querySelector('#preset-level-dialog');
  const source = document.querySelector('#preset-level-source');
  const list = document.querySelector('#preset-level-items');
  const preview = document.querySelector('#preset-level-preview');
  const error = document.querySelector('#preset-level-error');
  const jump = document.querySelector('#preset-level-jump');
  const summary = document.querySelector('#preset-level-summary');
  const download = document.querySelector('#preset-level-download');
  const openFile = document.querySelector('#open-local-level-file');
  const input = document.querySelector('#local-level-file-input');
  const save = document.querySelector('#save-selected-level-file');
  const saveAs = document.querySelector('#save-selected-level-file-as');
  let presets = [];
  let levels = [];
  let activeIndex = 0;
  let selectedWord = null;
  let request = 0;
  let busy = false;

  async function read(file) {
    const response = await fetch(new URL(file, new URL('./data/', import.meta.url)));
    if (!response.ok) throw new Error('预设关卡读取失败，请重试。');
    return response.json();
  }
  function failure(problem) {
    if (problem.name === 'AbortError') return;
    error.textContent = problem.message || '无法读取或保存关卡文件。';
    error.hidden = false;
  }
  function renderOptions() {
    source.replaceChildren(new Option('浏览器关卡', 'browser'));
    const groups = [
      ['本次打开的本地文件', getFiles().map(file => ({ ...file, label: file.label + (file.dirty ? ' · 未保存' : ''), levelCount: file.records.length }))],
      ['自带预设 · 本地版本', presets.filter(preset => preset.format === 'editor')],
      ['自带预设 · 参考竞品', presets.filter(preset => preset.format !== 'editor')],
    ];
    for (const [label, entries] of groups) {
      if (!entries.length) continue;
      const group = document.createElement('optgroup'); group.label = label;
      for (const item of entries) group.append(new Option(`${item.label}（${item.levelCount} 关）`, item.id));
      source.append(group);
    }
    source.value = getView().id;
    source.disabled = openFile.disabled = busy || getView().busy;
  }
  function renderPreview() {
    const level = levels[activeIndex];
    preview.replaceChildren();
    if (!level) { preview.textContent = '当前列表为空，可在主编辑器中生成关卡。'; return; }
    jump.value = String(activeIndex + 1);
    [...list.children].forEach((button, index) => button.setAttribute('aria-pressed', String(index === activeIndex)));
    const heading = document.createElement('h3');
    heading.textContent = `关卡 ${String(activeIndex + 1).padStart(3, '0')} · ${level.rows} × ${level.columns}`;
    const meta = document.createElement('p'); meta.className = 'preset-level-metadata';
    meta.textContent = `目标词 ${level.targetWords.length} · 额外词 ${level.extraWords.length}` + (level.sourceId === null ? '' : ` · 原关卡 ID ${level.sourceId}`);
    const board = document.createElement('div'); board.className = 'preset-level-board';
    board.style.setProperty('--preset-columns', String(level.columns));
    board.setAttribute('aria-label', '关卡棋盘');
    const selected = [...level.targetWords, ...level.extraWords].find(entry => entry.word === selectedWord);
    const path = selected ? selected.path ?? findPresetWordPath(level, selected.word) : [];
    level.letters.forEach((letter, index) => {
      const cell = document.createElement('div'); cell.className = 'preset-level-cell'; cell.textContent = letter;
      cell.classList.toggle('is-disabled', level.disabledCells.includes(index));
      const step = path?.indexOf(index) ?? -1;
      if (step >= 0) { cell.classList.add('is-selected'); const order = document.createElement('small'); order.textContent = String(step + 1); cell.append(order); }
      board.append(cell);
    });
    preview.append(heading, meta, board);
    for (const [label, words] of [['目标词', level.targetWords], ['额外词', level.extraWords]]) {
      const title = document.createElement('h4'); title.textContent = `${label}（${words.length}）`;
      const group = document.createElement('div'); group.className = 'preset-level-words';
      for (const entry of words) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'reset-button';
        button.textContent = entry.word; button.dataset.presetWord = entry.word;
        button.setAttribute('aria-pressed', String(entry.word === selectedWord)); bindWordTooltip(button, entry); group.append(button);
      }
      preview.append(title, group);
    }
  }
  function refresh() {
    if (!dialog.open) return;
    const view = getView(); renderOptions();
    levels = normalizePresetLevels({ records: view.records }, 'editor');
    activeIndex = Math.max(0, view.records.findIndex(record => record.id === view.activeId));
    selectedWord = null;
    summary.textContent = `${view.label} · ${levels.length} 关 · ${view.status}`;
    save.hidden = saveAs.hidden = view.kind !== 'file';
    save.textContent = view.saveLabel ?? '保存文件';
    save.disabled = busy || view.busy || (Boolean(view.handle) && !view.dirty) || view.pending;
    saveAs.disabled = busy || view.busy || view.pending;
    saveAs.hidden ||= !view.canSaveAs;
    jump.max = String(levels.length); jump.disabled = busy || !levels.length;
    download.hidden = true;
    const preset = presets.find(item => item.id === view.id);
    if (preset?.gameFile) {
      download.href = new URL(preset.gameFile, new URL('./data/', import.meta.url)).href;
      download.download = `${preset.id}-word-tiles-levels.json`; download.hidden = false;
    }
    const fragment = document.createDocumentFragment();
    levels.forEach((level, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'preset-level-item';
      button.dataset.presetIndex = String(index); button.disabled = busy || view.busy;
      button.textContent = `${String(index + 1).padStart(3, '0')}　${level.targetWords.map(entry => entry.word).join(' · ')}`;
      fragment.append(button);
    });
    const scroll = list.scrollTop; list.replaceChildren(fragment); list.scrollTop = scroll;
    renderPreview();
  }
  async function perform(operation) {
    if (busy) return;
    busy = true; error.hidden = true; refresh();
    try { await operation(); }
    catch (problem) { failure(problem); }
    finally { busy = false; refresh(); }
  }
  async function selectSource() {
    const id = source.value, token = ++request;
    await perform(async () => {
      if (id === 'browser') onBrowser();
      else if (getFiles().some(file => file.id === id)) onFile(id);
      else {
        const preset = presets.find(item => item.id === id);
        if (!preset) throw new Error('关卡来源不存在。');
        const data = await read(preset.file);
        if (normalizePresetLevels(data, preset.format).length !== preset.levelCount) throw new Error('预设关卡数量与记录不一致。');
        await onSelect({ preset, data, isCurrent: () => token === request });
      }
    });
  }
  function selectLevel(index, scroll = false) {
    if (busy || !Number.isInteger(index) || !levels[index]) return;
    try { onLevelSelect(index); activeIndex = index; selectedWord = null; renderPreview(); }
    catch (problem) { failure(problem); }
    if (scroll) list.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }
  document.querySelector('#open-preset-levels').addEventListener('click', async () => {
    if (dialog.open) return;
    dialog.showModal(); error.hidden = true; refresh();
    if (presets.length) return;
    try {
      const [reference, history] = await Promise.all([read('preset-level-lists.json'), read('local-versions.json')]);
      presets = [...history.versions.map(version => ({ ...version, file: version.levels, format: 'editor' })), ...reference.referenceLists];
      refresh();
    } catch (problem) { failure(problem); }
  });
  openFile.addEventListener('click', () => {
    if (!window.showOpenFilePicker) { input.click(); return; }
    // Call the picker inside the click's activation, before reading any data.
    perform(async () => {
      const [handle] = await window.showOpenFilePicker({ id: 'level-files', multiple: false,
        types: [{ description: '关卡 JSON', accept: { 'application/json': ['.json'] } }] });
      await onOpenFile(await handle.getFile(), handle);
    });
  });
  input.addEventListener('change', () => {
    const file = input.files[0]; input.value = '';
    if (file) perform(() => onOpenFile(file, null));
  });
  save.addEventListener('click', () => perform(() => onSaveFile(false)));
  saveAs.addEventListener('click', () => perform(() => onSaveFile(true)));
  source.addEventListener('change', selectSource);
  document.querySelector('#close-preset-levels').addEventListener('click', () => dialog.close());
  list.addEventListener('click', event => { const button = event.target.closest('[data-preset-index]'); if (button) selectLevel(Number(button.dataset.presetIndex)); });
  list.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !levels.length) return;
    event.preventDefault(); selectLevel(Math.max(0, Math.min(levels.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1))), true);
    list.children[activeIndex]?.focus({ preventScroll: true });
  });
  jump.addEventListener('change', () => selectLevel(jump.valueAsNumber - 1, true));
  preview.addEventListener('click', event => {
    const button = event.target.closest('[data-preset-word]'); if (!button) return;
    selectedWord = selectedWord === button.dataset.presetWord ? null : button.dataset.presetWord; renderPreview();
    [...preview.querySelectorAll('[data-preset-word]')].find(item => item.dataset.presetWord === button.dataset.presetWord)?.focus();
  });
  return { refresh };
}
