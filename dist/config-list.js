import { CONFIG_NUMBER_FIELDS, CONFIG_FILTER_OPTIONS, MAX_CONFIG_ROWS, readConfigList, saveConfigList,
  patchLevelConfigs, resizeTargetPlan, validateConfigNumber, validateLevelConfig, hasConfigPreset, installConfigPreset } from "./level-config.js";
import { countTargetLengthPlan } from "./level-generator.js";
import { renderTargetPlanChoices } from "./target-plan-controls.js";
import { REFERENCE_CONFIG_ID } from "./reference-config.js";
import { formatBatchState } from "./batch-runner.js";
import { defaultGenerationWorkers, detectedProcessorCount } from "./generation-client.js";
import { mountFixedBoardEditor } from "./fixed-board-editor.js";

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
  const stopButton = document.querySelector("#stop-config-run");
  const runProgress = document.querySelector("#config-run-progress");
  const runStatus = document.querySelector("#config-run-status");
  const runMeter = document.querySelector("#config-run-meter");
  const workerInfo = document.querySelector("#config-worker-info");
  const columns = ["rows", "columns", "targetCount", "targets", "fixedWords", "initialMaxWordLength", "maxWordLength",
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

  async function startRun(onlySelected) {
    if (running || !persist()) return;
    const jobs = records.map((record, index) => ({ ...record, position: index + 1 }))
      .filter(record => !onlySelected || selected.has(record.id));
    if (!jobs.length) { showError("请先选择要运行的配置。"); return; }
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

  async function initializeReferenceConfig() {
    openButton.disabled = true;
    openButton.setAttribute("aria-busy", "true");
    try {
      if (!hasConfigPreset(REFERENCE_CONFIG_ID)) {
        const response = await fetch(new URL("./data/list0-configs.json", import.meta.url));
        if (!response.ok) throw new Error("参考配置加载失败，请刷新重试。");
        const preset = await response.json();
        if (preset.id !== REFERENCE_CONFIG_ID || preset.records?.length !== 1500) throw new Error("参考配置数据不完整。");
        installConfigPreset(preset);
      }
    } catch (failure) {
      presetLoadError = failure.name === "QuotaExceededError" ? "本地存储空间不足，参考配置未写入。" : failure.message;
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
  }

  function planSummary(config) {
    try {
      const counts = countTargetLengthPlan(config.targetCount, config.targetLengthPlan);
      return counts ? `短${counts.short} 中${counts.medium} 长${counts.long}` : "不限词长";
    } catch {
      return "需调整";
    }
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
    row.querySelector("[data-config-action='targets']").textContent = planSummary(config);
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
          button.textContent = field === "fixedWords" ? record.config.fixedWords?.join(" · ") || "未设置"
            : field === "targets" ? planSummary(record.config)
            : Object.keys(record.config.filters).length ? `${Object.keys(record.config.filters).length} 项筛选` : "全部";
          if (field === "fixedWords") button.title = record.config.fixedWords?.join(", ") || "设置一个或多个固定单词";
          button.setAttribute("aria-label", `第 ${index + 1} 关${field === "targets" ? "目标词长配置" : field === "fixedWords" ? "固定单词" : "词库筛选"}`);
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
      saveConfigList(records);
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

  function renderDetailTargets() {
    const { targetCount, targetLengthPlan } = detailState.config;
    const container = detailContent.querySelector(".target-plan-slots");
    container.hidden = targetLengthPlan === null;
    if (targetLengthPlan !== null) renderTargetPlanChoices(container, targetLengthPlan, "config-detail-plan");
    else container.replaceChildren();
    detailContent.querySelector(".target-plan-summary").textContent = planSummary({ targetCount, targetLengthPlan });
  }

  function openDetails(kind, ids) {
    const source = records.find(record => ids.includes(record.id));
    if (!source) return;
    const settings = records.filter(record => ids.includes(record.id)).map(record => record.config);
    if (kind === "fixedWords") {
      try {
        validateConfigNumber("rows", source.config.rows); validateConfigNumber("columns", source.config.columns);
        if (settings.some(config => config.rows !== source.config.rows || config.columns !== source.config.columns)) throw new Error("批量摆放固定单词时，所选关卡的棋盘尺寸需一致。");
      } catch (failure) { showError(failure.message); return; }
    }
    fixedBoardEditor?.destroy(); fixedBoardEditor = null;
    detail.classList.toggle("fixed-board-dialog", kind === "fixedWords");
    detailState = { kind, ids: [...ids], config: structuredClone(source.config) };
    detailTitle.textContent = `${ids.length > 1 ? `所选 ${ids.length} 关 · ` : `第 ${records.indexOf(source) + 1} 关 · `}${kind === "targets" ? "关卡目标词" : kind === "fixedWords" ? "固定单词" : "词库筛选"}`;
    detailError.hidden = true;
    if (kind === "targets") {
      detailContent.innerHTML = '<div class="target-config-count"><label for="config-detail-target-count">目标数量</label><input id="config-detail-target-count" type="number" min="1" step="1" /></div><label class="target-plan-switch"><input id="config-detail-plan-enabled" type="checkbox" />逐个配置词长</label><div class="target-plan-slots"></div><output class="target-plan-summary"></output>';
      detailContent.querySelector("#config-detail-target-count").value = String(source.config.targetCount);
      detailContent.querySelector("#config-detail-plan-enabled").checked = source.config.targetLengthPlan !== null;
      renderDetailTargets();
    } else if (kind === "fixedWords") {
      fixedBoardEditor = mountFixedBoardEditor(detailContent, source.config, { configs: settings, onError: message => {
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

  for (const [value, label] of [...Object.entries(CONFIG_NUMBER_FIELDS).map(([key, rule]) => [key, rule.label]),
    ["targets", "关卡目标词"], ["fixedWords", "固定单词"], ["filters", "词库筛选"]]) batchField.add(new Option(label, value));

  openButton.addEventListener("click", () => {
    workerInfo.textContent = `自动并行 ${defaultGenerationWorkers()} 路`;
    workerInfo.title = `检测到 ${detectedProcessorCount()} 个逻辑核心；并行数按核心数减 1 计算，至少 1 路。`;
    error.hidden = true;
    try {
      const saved = readConfigList();
      records = saved ?? [{ id: crypto.randomUUID(), config: structuredClone(getConfig()) }];
      saveButton.textContent = saved ? "已保存" : "保存配置";
      saveButton.disabled = saved !== null;
    } catch (failure) {
      records = [];
      saveButton.textContent = "保存配置";
      saveButton.disabled = false;
      showError(`配置列表读取失败：${failure.message}`);
    }
    selected = runState ? new Set([...selected].filter(id => records.some(record => record.id === id))) : new Set();
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
  runSelectedButton.addEventListener("click", () => startRun(true));
  runAllButton.addEventListener("click", () => startRun(false));
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
    record.config[field] = event.target.valueAsNumber;
    if (field === "targetCount") {
      try { record.config.targetLengthPlan = resizeTargetPlan(record.config.targetLengthPlan, record.config.targetCount); } catch { /* Preserve the plan while an incomplete count is being edited. */ }
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
  detailContent.addEventListener("input", event => {
    detailError.hidden = true;
    if (detailState?.kind !== "targets") return;
    const config = detailState.config;
    if (event.target.matches("input[data-target-index]")) {
      config.targetLengthPlan[Number(event.target.dataset.targetIndex)] = event.target.value;
      detailContent.querySelector(".target-plan-summary").textContent = planSummary(config);
      return;
    }
    config.targetCount = detailContent.querySelector("#config-detail-target-count").valueAsNumber;
    const enabled = detailContent.querySelector("#config-detail-plan-enabled").checked;
    try {
      config.targetLengthPlan = enabled ? resizeTargetPlan(config.targetLengthPlan ?? [], config.targetCount) : null;
      renderDetailTargets();
    } catch (failure) { showError(failure.message, detailError); }
  });
  document.querySelector("#apply-config-detail").addEventListener("click", () => {
    if (!detailState) return;
    const { kind, ids, config } = detailState;
    let patch;
    if (kind === "targets") {
      // Validate the currently visible draft, including the count when length selection is off.
      patch = { targetCount: detailContent.querySelector("#config-detail-target-count").valueAsNumber,
        targetLengthPlan: detailContent.querySelector("#config-detail-plan-enabled").checked ? config.targetLengthPlan ?? [] : null };
    } else if (kind === "fixedWords") {
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
