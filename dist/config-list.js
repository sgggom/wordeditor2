import { resizeDisabledCells } from "./board-shape.js";
import { CONFIG_NUMBER_FIELDS, CONFIG_FILTER_OPTIONS, MAX_CONFIG_ROWS, readConfigLists, migrateConfigLists, changeConfigLists, saveConfigList,
  patchLevelConfigs, validateConfigNumber, validateLevelConfig, installConfigPreset, configJobsInRange } from "./level-config.js";
import { REFERENCE_CONFIG_ID } from "./reference-config.js";
import { formatBatchState } from "./batch-runner.js";
import { defaultGenerationWorkers, detectedProcessorCount } from "./generation-client.js";
import { mountFixedBoardEditor, createConfigBoardPreview } from "./fixed-board-editor.js";
import { configureOpeningWords, OPENING_WORDS_PRESET_ID } from "./opening-words-preset.js";

export function setupConfigList({ getConfig, loadConfig, runConfigs, stopRun }) {
  const openButton = document.querySelector("#open-config-list");
  const dialog = document.querySelector("#level-config-dialog");
  const body = document.querySelector("#config-list-body");
  const error = document.querySelector("#config-list-error");
  const count = document.querySelector("#config-list-count");
  const selectedCount = document.querySelector("#config-selected-count");
  const selectAll = document.querySelector("#config-select-all");
  const addCount = document.querySelector("#config-add-count");
  const saveButton = document.querySelector("#save-config-list");
  const deleteButton = document.querySelector("#delete-config-rows");
  const batchField = document.querySelector("#config-batch-field");
  const batchValue = document.querySelector("#config-batch-value");
  const batchApply = document.querySelector("#apply-config-batch");
  const detail = document.querySelector("#config-detail-dialog");
  const detailTitle = document.querySelector("#config-detail-title");
  const detailContent = document.querySelector("#config-detail-content");
  const detailError = document.querySelector("#config-detail-error");
  const runSelectedButton = document.querySelector("#run-selected-configs");
  const runAllButton = document.querySelector("#run-all-configs");
  const rangeDialog = document.querySelector("#config-run-range-dialog");
  const rangeForm = document.querySelector("#config-run-range-form");
  const rangeFrom = document.querySelector("#config-run-from");
  const rangeTo = document.querySelector("#config-run-to");
  const rangeSummary = document.querySelector("#config-run-range-summary");
  const rangeError = document.querySelector("#config-run-range-error");
  const stopButton = document.querySelector("#stop-config-run");
  const runProgress = document.querySelector("#config-run-progress");
  const runStatus = document.querySelector("#config-run-status");
  const runMeter = document.querySelector("#config-run-meter");
  const workerInfo = document.querySelector("#config-worker-info");
  const listSelect = document.querySelector("#config-list-select");
  const newListButton = document.querySelector("#new-config-list");
  const manageListsButton = document.querySelector("#manage-config-lists");
  const listManager = document.querySelector("#config-list-manager");
  const managerItems = document.querySelector("#config-list-manager-items");
  const managerError = document.querySelector("#config-list-manager-error");
  const deleteConfirm = document.querySelector("#config-list-delete-confirm");
  const deleteMessage = document.querySelector("#config-list-delete-message");
  const nameDialog = document.querySelector("#config-list-name-dialog");
  const nameForm = document.querySelector("#config-list-name-form");
  const nameInput = document.querySelector("#config-list-name");
  const nameError = document.querySelector("#config-list-name-error");
  let library = null;
  let activeListId = null;
  let nameAction = null;
  let pendingDeleteId = null;
  const columns = ["fixedWords",
    "initialForwardProbability", "targetDuplicateRange", "extraDuplicateRange", "filters"];
  let records = [];
  let selected = new Set();
  let detailState = null;
  let fixedBoardEditor = null;
  let presetLoadError = "";
  let running = false;
  let runState = null;
  let originalDisabled = new WeakMap();
  let rowElements = new Map();
  let highlightedRow = null;

  function lockRunControls(locked) {
    for (const control of dialog.querySelectorAll("button, input, select")) {
      if (control.matches("[data-close-config-list], #stop-config-run")) continue;
      if (locked) {
        if (!originalDisabled.has(control)) originalDisabled.set(control, control.disabled);
        control.disabled = true;
      } else if (originalDisabled.has(control)) {
        control.disabled = originalDisabled.get(control);
      }
    }
  }

  function markRunningRow() {
    const next = running && runState ? rowElements.get(runState.configId) : null;
    if (next === highlightedRow) return;
    highlightedRow?.classList.remove("is-running");
    highlightedRow = next;
    highlightedRow?.classList.add("is-running");
  }

  function updateRunState(state) {
    runState = state;
    runProgress.hidden = false;
    runStatus.textContent = formatBatchState(state);
    runStatus.classList.toggle("is-error", state.phase === "error");
    runMeter.max = state.total;
    runMeter.value = state.completed;
    stopButton.hidden = !running;
    stopButton.disabled = ["stopping", "stopped", "complete", "error"].includes(state.phase);
    if (state.phase === "saved") {
      selected.delete(state.configId);
      renderSelection();
    }
    markRunningRow();
  }

  async function startRun(jobs) {
    if (running) return;
    if (!persist()) {
      if (rangeDialog.open) showError(error.textContent, rangeError);
      return;
    }
    if (!jobs.length) { showError("请先选择要运行的配置。"); return; }
    if (rangeDialog.open) rangeDialog.close();
    selected = new Set(jobs.map(job => job.id));
    running = true;
    originalDisabled = new WeakMap();
    renderSelection();
    lockRunControls(true);
    updateRunState({ phase: "loading", total: jobs.length, completed: 0, position: jobs[0].position,
      configId: jobs[0].id, attempts: 0, error: "" });
    try {
      await runConfigs(jobs, updateRunState);
    } catch (failure) {
      updateRunState({ ...runState, phase: "error", error: failure.message || "运行失败，请重试。" });
    } finally {
      running = false;
      lockRunControls(false);
      stopButton.hidden = true;
      renderSelection();
      markRunningRow();
    }
  }

  function renderRangeSummary() {
    try {
      const jobs = configJobsInRange(records, rangeFrom.valueAsNumber, rangeTo.valueAsNumber);
      rangeSummary.textContent = `第 ${rangeFrom.valueAsNumber}～${rangeTo.valueAsNumber} 关 · 共 ${jobs.length} 关`;
    } catch {
      rangeSummary.textContent = `可选 1～${records.length} 关`;
    }
  }

  async function initializeReferenceConfig() {
    openButton.disabled = true;
    openButton.setAttribute("aria-busy", "true");
    try {
      library = migrateConfigLists();
      if (!library) {
        const response = await fetch(new URL("./data/list0-configs.json", import.meta.url));
        if (!response.ok) throw new Error("参考配置加载失败，请刷新重试。");
        const preset = await response.json();
        if (preset.id !== REFERENCE_CONFIG_ID || preset.records?.length !== 1500) throw new Error("参考配置数据不完整。");
        installConfigPreset({ ...preset, records: configureOpeningWords(preset.records), openingWordsPresetId: OPENING_WORDS_PRESET_ID });
        library = readConfigLists();
      }
      activeListId = library.activeListId;
    } catch (failure) {
      presetLoadError = failure.name === "QuotaExceededError" ? "本地存储空间不足，配置列表初始化未保存。" : failure.message;
    } finally {
      openButton.disabled = false;
      openButton.setAttribute("aria-busy", "false");
    }
  }

  function showError(message, output = error) {
    output.textContent = message;
    output.hidden = false;
  }

  function changed() {
    saveButton.disabled = false;
    saveButton.textContent = "保存配置";
    error.hidden = true;
    renderLibrarySelection();
  }

  function renderSelection() {
    count.textContent = String(records.length);
    selectedCount.textContent = String(selected.size);
    selectAll.checked = records.length > 0 && selected.size === records.length;
    selectAll.indeterminate = selected.size > 0 && selected.size < records.length;
    selectAll.disabled = running || records.length === 0;
    batchApply.disabled = deleteButton.disabled = runSelectedButton.disabled = running || selected.size === 0;
    runAllButton.disabled = running || records.length === 0;
    for (const checkbox of body.querySelectorAll("input[data-select-config]")) {
      checkbox.checked = selected.has(checkbox.dataset.selectConfig);
      checkbox.closest("tr").classList.toggle("is-selected", checkbox.checked);
    }
  }

  function renderRowValidity(row, config) {
    let valid = true;
    try { validateLevelConfig(config); } catch { valid = false; }
    row.classList.toggle("is-invalid", !valid);
    for (const input of row.querySelectorAll("input[data-config-field]")) {
      let fieldValid = true;
      try { validateConfigNumber(input.dataset.configField, config[input.dataset.configField]); } catch { fieldValid = false; }
      input.setAttribute("aria-invalid", String(!fieldValid));
    }
    const preview = row.querySelector("[data-config-action='fixedWords']");
    preview.replaceChildren(createConfigBoardPreview(config));
    preview.title = `${config.rows} 行 × ${config.columns} 列 · ${config.rows * config.columns - (config.disabledCells?.length ?? 0)} 格` +
      (config.fixedWords?.length ? `；固定词：${config.fixedWords.join("、")}` : "；点击编辑棋盘与固定单词");
  }

  function renderRows() {
    const scroll = body.closest(".config-table-scroll");
    const scrollTop = scroll.scrollTop;
    const fragment = document.createDocumentFragment();
    rowElements = new Map();
    for (const [index, record] of records.entries()) {
      const row = document.createElement("tr");
      row.dataset.configId = record.id;
      rowElements.set(record.id, row);
      const selectCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.selectConfig = record.id;
      checkbox.setAttribute("aria-label", `选择第 ${index + 1} 关配置`);
      selectCell.append(checkbox);
      const number = document.createElement("th");
      number.scope = "row";
      number.textContent = String(index + 1).padStart(3, "0");
      row.append(selectCell, number);
      for (const field of columns) {
        const cell = document.createElement("td");
        const rule = CONFIG_NUMBER_FIELDS[field];
        if (rule) {
          const input = document.createElement("input");
          input.type = "number";
          input.min = String(rule.min);
          if (rule.max !== undefined) input.max = String(rule.max);
          input.step = "1";
          input.value = Number.isFinite(record.config[field]) ? String(record.config[field]) : "";
          input.dataset.configField = field;
          input.setAttribute("aria-label", `第 ${index + 1} 关${rule.label}`);
          cell.append(input);
        } else {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "config-cell-button";
          button.dataset.configAction = field;
          if (field === "fixedWords") {
            button.classList.add("config-board-button");

          } else {
            button.textContent = Object.keys(record.config.filters).length ? `${Object.keys(record.config.filters).length} 项筛选` : "全部";
          }
          button.setAttribute("aria-label", `第 ${index + 1} 关${field === "fixedWords" ? "棋盘编辑" : "词库筛选"}`);
          cell.append(button);
        }
        row.append(cell);
      }
      const useCell = document.createElement("td");
      const useButton = document.createElement("button");
      useButton.type = "button";
      useButton.className = "config-cell-button config-use-button";
      useButton.dataset.configAction = "load";
      useButton.textContent = "载入";
      useButton.title = "保存配置列表并载入此关配置";
      useButton.setAttribute("aria-label", `载入第 ${index + 1} 关配置`);
      useCell.append(useButton);
      row.append(useCell);
      renderRowValidity(row, record.config);
      fragment.append(row);
    }
    if (!records.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = columns.length + 3;
      cell.className = "config-list-empty";
      cell.textContent = "暂无关卡配置";
      row.append(cell);
      fragment.append(row);
    }
    body.replaceChildren(fragment);
    renderSelection();
    markRunningRow();
    scroll.scrollTop = scrollTop;
  }

  function renderBatchField() {
    const field = batchField.value;
    const rule = CONFIG_NUMBER_FIELDS[field];
    batchValue.hidden = !rule;
    batchApply.textContent = rule ? "应用到所选" : "配置并应用";
    if (rule) {
      const first = records.find(record => selected.has(record.id))?.config ?? getConfig();
      batchValue.min = String(rule.min);
      if (rule.max === undefined) batchValue.removeAttribute("max");
      else batchValue.max = String(rule.max);
      batchValue.value = String(first[field]);
      batchValue.setAttribute("aria-label", `批量设置${rule.label}`);
    }
  }

  function persist() {
    if (running) return false;
    try {
      library = changeConfigLists({ type: "save", id: activeListId, draft: { id: activeListId, records } });
      renderLibrarySelection();
      error.hidden = true;
      saveButton.textContent = "已保存";
      saveButton.disabled = true;
      return true;
    } catch (failure) {
      showError(failure.name === "QuotaExceededError" ? "本地存储空间不足，配置未保存。" : failure.message || "配置保存失败，请重试。");
      body.querySelector("[aria-invalid='true']")?.focus();
      return false;
    }
  }

  function applyPatch(ids, patch) {
    records = patchLevelConfigs(records, ids, patch);
    changed();
    renderRows();
  }

  function openDetails(kind, ids) {
    const source = records.find(record => ids.includes(record.id));
    if (!source) return;
    const settings = records.filter(record => ids.includes(record.id)).map(record => record.config);
    if (kind === "fixedWords") {
      try {
        for (const config of settings) { validateConfigNumber("rows", config.rows); validateConfigNumber("columns", config.columns); }
      } catch (failure) { showError(failure.message); return; }
    }
    fixedBoardEditor?.destroy(); fixedBoardEditor = null;
    detail.classList.toggle("fixed-board-dialog", kind === "fixedWords");
    detailState = { kind, ids: [...ids], config: structuredClone(source.config) };
    detailTitle.textContent = `${ids.length > 1 ? `所选 ${ids.length} 关 · ` : `第 ${records.indexOf(source) + 1} 关 · `}${kind === "fixedWords" ? "棋盘编辑" : "词库筛选"}`;
    detailError.hidden = true;
    if (kind === "fixedWords") {
      fixedBoardEditor = mountFixedBoardEditor(detailContent, detailState.config, { configs: settings, onError: message => {
        detailError.hidden = !message;
        detailError.textContent = message;
      } });
    } else {
      const fields = document.querySelector("#word-filter-panel .filter-fields").cloneNode(true);
      for (const input of fields.querySelectorAll("input[data-word-filter]")) {
        input.checked = source.config.filters[input.dataset.wordFilter]?.includes(Number(input.value)) ?? true;
      }
      detailContent.replaceChildren(fields);
    }
    detail.showModal();
  }

  function renderLibrarySelection() {
    listSelect.replaceChildren(...(library?.lists ?? []).map(list => new Option(
      `${list.name}（${list.id === activeListId ? records.length : list.records.length} 关）`, list.id)));
    listSelect.value = activeListId ?? "";
    listSelect.disabled = newListButton.disabled = manageListsButton.disabled = running || !activeListId;
  }

  function renderListManager() {
    const fragment = document.createDocumentFragment();
    for (const list of library?.lists ?? []) {
      const current = list.id === activeListId;
      const row = document.createElement("div");
      row.className = `config-list-manager-item${current ? " is-active" : ""}`;
      row.dataset.listId = list.id;
      const info = document.createElement("div"); info.className = "config-list-manager-info";
      const title = document.createElement("strong"); title.textContent = list.name;
      const meta = document.createElement("span");
      meta.textContent = `${current ? records.length : list.records.length} 关配置${current ? " · 当前列表" : ""}`;
      info.append(title, meta);
      const actions = document.createElement("div"); actions.className = "config-list-manager-actions";
      for (const [action, label] of [["switch", current ? "当前" : "切换"], ["rename", "重命名"], ["copy", "复制"], ["delete", "删除"]]) {
        const button = document.createElement("button");
        button.type = "button"; button.className = `reset-button${action === "delete" ? " config-list-delete-button" : ""}`;
        button.dataset.listAction = action; button.textContent = label;
        button.disabled = running || (action === "switch" && current) || (action === "delete" && library.lists.length === 1);
        if (action === "delete" && library.lists.length === 1) button.title = "至少保留一个列表";
        button.setAttribute("aria-label", `${label} ${list.name}`);
        actions.append(button);
      }
      row.append(info, actions); fragment.append(row);
    }
    managerItems.replaceChildren(fragment);
  }

  function adoptLibrary(next) {
    const switched = activeListId !== next.activeListId;
    library = next; activeListId = next.activeListId;
    records = structuredClone(next.lists.find(list => list.id === activeListId).records);
    if (switched) { selected.clear(); runState = null; runProgress.hidden = true; }
    else selected = new Set([...selected].filter(id => records.some(record => record.id === id)));
    saveButton.disabled = true; saveButton.textContent = "已保存"; error.hidden = true;
    renderLibrarySelection(); renderRows(); renderBatchField();
    if (listManager.open) renderListManager();
  }

  function performListAction(action, output = error) {
    if (running || !activeListId) return false;
    try {
      const next = changeConfigLists({ ...action, draft: { id: activeListId, records } });
      adoptLibrary(next);
      output.hidden = true;
      return true;
    } catch (failure) {
      showError(failure.name === "QuotaExceededError" ? "本地存储空间不足，列表操作未保存。" : failure.message || "列表操作失败，请重试。", output);
      listSelect.value = activeListId;
      return false;
    }
  }

  function suggestedListName(base) {
    let name = base.slice(0, 40), index = 2;
    while (library.lists.some(list => list.name.toLowerCase() === name.toLowerCase())) {
      const suffix = ` ${index++}`;
      name = base.slice(0, 40 - suffix.length) + suffix;
    }
    return name;
  }

  function openListName(type, id) {
    if (running || !library) return;
    const list = library.lists.find(entry => entry.id === id);
    if (type !== "create" && !list) return;
    nameAction = { type, ...(id ? { id } : {}) };
    document.querySelector("#config-list-name-title").textContent = { create: "新建列表", rename: "重命名列表", copy: "复制列表" }[type];
    document.querySelector("#submit-config-list-name").textContent = type === "rename" ? "保存名称" : "创建";
    nameInput.value = type === "rename" ? list.name : suggestedListName(type === "copy" ? `${list.name.slice(0, 36)} 副本` : "新列表");
    nameError.hidden = true; deleteConfirm.hidden = true; pendingDeleteId = null;
    nameDialog.showModal(); nameInput.focus(); nameInput.select();
  }

  newListButton.addEventListener("click", () => openListName("create"));
  document.querySelector("#manager-new-config-list").addEventListener("click", () => openListName("create"));
  listSelect.addEventListener("change", () => {
    if (listSelect.value !== activeListId) performListAction({ type: "switch", id: listSelect.value });
  });
  manageListsButton.addEventListener("click", () => {
    if (running || !library) return;
    managerError.hidden = true; deleteConfirm.hidden = true; pendingDeleteId = null;
    renderListManager(); listManager.showModal();
  });
  for (const button of listManager.querySelectorAll("[data-close-list-manager]")) button.addEventListener("click", () => listManager.close());
  for (const button of nameDialog.querySelectorAll("[data-close-list-name]")) button.addEventListener("click", () => nameDialog.close());
  nameDialog.addEventListener("close", () => { nameAction = null; });
  nameInput.addEventListener("input", () => { nameError.hidden = true; });
  nameForm.addEventListener("submit", event => {
    event.preventDefault();
    if (nameAction && performListAction({ ...nameAction, name: nameInput.value }, nameError)) nameDialog.close();
  });
  managerItems.addEventListener("click", event => {
    const button = event.target.closest("button[data-list-action]");
    if (!button || button.disabled || running) return;
    const id = button.closest("[data-list-id]").dataset.listId;
    const type = button.dataset.listAction;
    managerError.hidden = true; deleteConfirm.hidden = true; pendingDeleteId = null;
    if (type === "rename" || type === "copy") openListName(type, id);
    else if (type === "switch") performListAction({ type, id }, managerError);
    else if (type === "delete") {
      const list = library.lists.find(entry => entry.id === id);
      pendingDeleteId = id;
      deleteMessage.textContent = `确定删除“${list.name}”（${id === activeListId ? records.length : list.records.length} 关配置）？`;
      deleteConfirm.hidden = false;
      document.querySelector("#cancel-delete-config-list").focus();
    }
  });
  document.querySelector("#cancel-delete-config-list").addEventListener("click", () => { deleteConfirm.hidden = true; pendingDeleteId = null; });
  document.querySelector("#confirm-delete-config-list").addEventListener("click", () => {
    if (pendingDeleteId && performListAction({ type: "delete", id: pendingDeleteId }, managerError)) {
      deleteConfirm.hidden = true; pendingDeleteId = null;
    }
  });

  for (const [value, label] of [...Object.entries(CONFIG_NUMBER_FIELDS).map(([key, rule]) => [key, rule.label]),
    ["fixedWords", "棋盘编辑"], ["filters", "词库筛选"]]) batchField.add(new Option(label, value));

  openButton.addEventListener("click", () => {
    workerInfo.textContent = `自动并行 ${defaultGenerationWorkers()} 路`;
    workerInfo.title = `检测到 ${detectedProcessorCount()} 个逻辑核心；并行数按核心数减 1 计算，至少 1 路。`;
    error.hidden = true;
    try {
      library = readConfigLists();
      if (!library) {
        saveConfigList([{ id: crypto.randomUUID(), config: structuredClone(getConfig()) }]);
        library = readConfigLists();
      }
      activeListId = library.activeListId;
      records = structuredClone(library.lists.find(list => list.id === activeListId).records);
      saveButton.textContent = "已保存";
      saveButton.disabled = true;
    } catch (failure) {
      library = null; activeListId = null;
      records = [];
      saveButton.textContent = "保存配置";
      saveButton.disabled = false;
      showError(`配置列表读取失败：${failure.message}`);
    }
    selected = runState ? new Set([...selected].filter(id => records.some(record => record.id === id))) : new Set();
    renderLibrarySelection();
    renderRows();
    renderBatchField();
    if (running) lockRunControls(true);
    if (presetLoadError) showError(presetLoadError);
    dialog.showModal();
  });
  for (const button of dialog.querySelectorAll("[data-close-config-list]")) button.addEventListener("click", () => dialog.close());
  document.querySelector("#close-config-detail").addEventListener("click", () => detail.close());
  detail.addEventListener("close", () => { fixedBoardEditor?.destroy(); fixedBoardEditor = null; detailState = null; });
  saveButton.addEventListener("click", persist);
  runSelectedButton.addEventListener("click", () => startRun(records.map((record, index) => ({ ...record, position: index + 1 }))
    .filter(record => selected.has(record.id))));
  runAllButton.addEventListener("click", () => {
    if (running || !records.length) return;
    rangeFrom.max = rangeTo.max = String(records.length);
    rangeFrom.value = "1";
    rangeTo.value = String(records.length);
    rangeError.hidden = true;
    renderRangeSummary();
    rangeDialog.showModal();
    rangeFrom.focus();
    rangeFrom.select();
  });
  for (const button of rangeDialog.querySelectorAll("[data-close-run-range]")) button.addEventListener("click", () => rangeDialog.close());
  rangeForm.addEventListener("input", () => { rangeError.hidden = true; renderRangeSummary(); });
  rangeForm.addEventListener("submit", event => {
    event.preventDefault();
    if (!rangeDialog.open || running) return;
    try { startRun(configJobsInRange(records, rangeFrom.valueAsNumber, rangeTo.valueAsNumber)); }
    catch (failure) { showError(failure.message, rangeError); }
  });
  stopButton.addEventListener("click", () => stopRun());
  selectAll.addEventListener("change", () => {
    if (running) return;
    selected = selectAll.checked ? new Set(records.map(record => record.id)) : new Set();
    renderSelection();
  });
  batchField.addEventListener("change", renderBatchField);
  document.querySelector("#add-config-rows").addEventListener("click", () => {
    if (running) return;
    const amount = addCount.valueAsNumber;
    if (!Number.isSafeInteger(amount) || amount < 1 || records.length + amount > MAX_CONFIG_ROWS) {
      showError(`新增关数需为正整数，列表总数不能超过 ${MAX_CONFIG_ROWS} 关。`);
      addCount.focus();
      return;
    }
    const config = getConfig();
    const additions = Array.from({ length: amount }, () => ({ id: crypto.randomUUID(), config: structuredClone(config) }));
    records.push(...additions);
    selected = new Set(additions.map(record => record.id));
    changed();
    renderRows();
    body.lastElementChild?.scrollIntoView({ block: "nearest" });
  });
  deleteButton.addEventListener("click", () => {
    if (running) return;
    records = records.filter(record => !selected.has(record.id));
    selected.clear();
    changed();
    renderRows();
  });
  batchApply.addEventListener("click", () => {
    if (running || !selected.size) return;
    const field = batchField.value;
    if (!CONFIG_NUMBER_FIELDS[field]) {
      openDetails(field, [...selected]);
      return;
    }
    try {
      validateConfigNumber(field, batchValue.valueAsNumber);
      applyPatch(selected, { [field]: batchValue.valueAsNumber });
    } catch (failure) { showError(failure.message); }
  });
  body.addEventListener("change", event => {
    if (running) return;
    const id = event.target.dataset.selectConfig;
    if (!id) return;
    if (event.target.checked) selected.add(id);
    else selected.delete(id);
    renderSelection();
  });
  body.addEventListener("input", event => {
    if (running) return;
    const field = event.target.dataset.configField;
    if (!field) return;
    const row = event.target.closest("tr");
    const record = records.find(record => record.id === row.dataset.configId);
    const previousSize = { rows: record.config.rows, columns: record.config.columns, disabledCells: record.config.disabledCells };
    record.config[field] = event.target.valueAsNumber;
    if (["rows", "columns"].includes(field) && [previousSize.rows, previousSize.columns, record.config.rows, record.config.columns]
      .every(value => Number.isInteger(value) && value >= 2 && value <= 5)) {
      record.config.disabledCells = resizeDisabledCells(previousSize, record.config);
    }
    changed();
    renderRowValidity(row, record.config);
  });
  body.addEventListener("click", event => {
    if (running) return;
    const button = event.target.closest("button[data-config-action]");
    if (!button) return;
    const id = button.closest("tr").dataset.configId;
    if (button.dataset.configAction === "load") {
      if (!persist()) return;
      loadConfig(structuredClone(records.find(record => record.id === id).config));
      dialog.close();
    } else openDetails(button.dataset.configAction, [id]);
  });
  detailContent.addEventListener("input", () => { detailError.hidden = true; });
  document.querySelector("#apply-config-detail").addEventListener("click", () => {
    if (!detailState) return;
    const { kind, ids, config } = detailState;
    let patch;
    if (kind === "fixedWords") {
      try { patch = fixedBoardEditor.getValue(); }
      catch (failure) { showError(failure.message, detailError); return; }
    } else {
      const filters = {};
      for (const [key, options] of Object.entries(CONFIG_FILTER_OPTIONS)) {
        const values = [...detailContent.querySelectorAll(`input[data-word-filter="${key}"]:checked`)].map(input => Number(input.value));
        if (values.length !== options.length) filters[key] = values;
      }
      patch = { filters };
    }
    try {
      applyPatch(ids, patch);
      detail.close();
    } catch (failure) { showError(failure.message, detailError); }
  });
  initializeReferenceConfig();
}
