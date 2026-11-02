import { CONFIG_FILTER_OPTIONS, MAX_CONFIG_ROWS, validateConfigList } from "./level-config.js";
import { normalizeFixedWords } from "./fixed-words.js";

export const CONFIG_TABLE_HEADERS = ["关卡id", "棋盘造型", "初始单词1", "初始单词2", "范围库", "情绪", "生僻程度"];
export const CONFIG_TABLE_OPTIONAL_HEADERS = ["目标重复检测", "目标数量"];

// CSV supports quoted commas, escaped quotes, CRLF and multiline cells.
function readCsv(text) {
  const rows = [];
  let row = [], value = "", quoted = false, closed = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { value += '"'; index++; }
        else { quoted = false; closed = true; }
      } else value += char;
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(value); value = ""; closed = false;
      if (char !== ',') {
        rows.push(row); row = [];
        if (char === '\r' && source[index + 1] === '\n') index++;
      }
    } else if (char === '"' && !value && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error("CSV 引号格式无效，请用表格软件另存为 CSV UTF-8。");
      value += char;
    }
  }
  if (quoted) throw new Error("CSV 引号未闭合。");
  if (value || row.length || closed) rows.push([...row, value]);
  return rows;
}

function parseShape(value) {
  const size = /^([2-5])\s*[x×*]\s*([2-5])$/i.exec(value);
  if (size) return { columns: Number(size[1]), rows: Number(size[2]), disabledCells: [], randomBoardShape: true };
  const message = "棋盘造型需填写宽x高，如 3x3、4x3、5x3（宽高均为 2～5）；也兼容原二维数组。";
  let matrix;
  try { matrix = JSON.parse(value); } catch { throw new Error(message); }
  if (!Array.isArray(matrix) || matrix.length < 2 || matrix.length > 5 ||
      !Array.isArray(matrix[0]) || matrix[0].length < 2 || matrix[0].length > 5 ||
      matrix.some(row => !Array.isArray(row) || row.length !== matrix[0].length ||
        row.some(cell => cell !== 0 && cell !== 1))) {
    throw new Error(message);
  }
  return { rows: matrix.length, columns: matrix[0].length, randomBoardShape: false,
    disabledCells: matrix.flat().flatMap((cell, index) => cell === 0 ? [index] : []) };
}

function parseArray(text, field, label) {
  let values;
  try { values = JSON.parse(text); } catch { throw new Error(`${label}需填写数字数组，如 [1,2]；不限请填全部可选值。`); }
  if (!Array.isArray(values) || values.some(value => !CONFIG_FILTER_OPTIONS[field].includes(value))) {
    throw new Error(`${label}需为数组，可选值为 ${JSON.stringify(CONFIG_FILTER_OPTIONS[field])}。`);
  }
  return [...new Set(values)];
}

export function parseConfigTable(text, defaults) {
  return parseConfigTableRows(readCsv(text), defaults);
}

export function parseConfigTableRows(input, defaults) {
  const rows = input.map(row => row.map(value => String(value ?? "")));
  const headers = rows.shift()?.map(value => value.trim().toLowerCase());
  if (!headers || headers.some(label => ![...CONFIG_TABLE_HEADERS, ...CONFIG_TABLE_OPTIONAL_HEADERS].includes(label)) || new Set(headers).size !== headers.length ||
      CONFIG_TABLE_HEADERS.some(label => !headers.includes(label))) throw new Error(`表头需包含：${CONFIG_TABLE_HEADERS.join("、")}。`);
  const records = [], ids = new Set();
  for (const [index, row] of rows.entries()) {
    if (row.every(value => !value.trim())) continue;
    try {
      if (row.length !== headers.length) throw new Error("列数与表头不一致，数组单元格含逗号时需使用 CSV 引号。");
      const cells = Object.fromEntries(headers.map((label, column) => [label, row[column].trim()]));
      const levelId = cells["关卡id"];
      if (!levelId || ids.has(levelId)) throw new Error("关卡 id 不能为空或重复。");
      const words = [cells["初始单词1"], cells["初始单词2"]];
      if (words.some(word => word && !/^[a-z]+$/i.test(word))) throw new Error("初始单词只能填写一个英文单词，也可留空。");
      if (words[0] && words[0].toUpperCase() === words[1].toUpperCase()) throw new Error("两个初始单词不能相同。");
      const config = { ...structuredClone(defaults), ...parseShape(cells["棋盘造型"]),
        desiredTargetCount: defaults.desiredTargetCount ?? 0,
        fixedWords: normalizeFixedWords(words), fixedLayout: null, fixedWordExemptions: [],
        filters: { ...structuredClone(defaults.filters ?? {}),
          scope: parseArray(cells["范围库"], "scope", "范围库"),
          emotion: parseArray(cells["情绪"], "emotion", "情绪"),
          rarityLevel: parseArray(cells["生僻程度"], "rarityLevel", "生僻程度") } };
      if (headers.includes("目标重复检测")) {
        if (!/^\d+$/.test(cells["目标重复检测"])) throw new Error("目标重复检测需为 0 及以上的整数。");
        config.targetDuplicateRange = Number(cells["目标重复检测"]);
      }
      if (headers.includes("目标数量")) {
        if (cells["目标数量"] && !/^\d+$/.test(cells["目标数量"])) throw new Error("目标数量需留空或填写 0 及以上的整数。");
        config.desiredTargetCount = cells["目标数量"] ? Number(cells["目标数量"]) : 0;
      }
      const record = { id: crypto.randomUUID(), levelId, config };
      validateConfigList([record]);
      ids.add(levelId); records.push(record);
      if (records.length > MAX_CONFIG_ROWS) throw new Error(`配置表最多支持 ${MAX_CONFIG_ROWS} 关。`);
    } catch (error) { throw new Error(`配置表第 ${index + 2} 行：${error.message}`); }
  }
  if (!records.length) throw new Error("配置表中没有关卡数据。");
  return records;
}

function csv(rows) {
  return "\uFEFF" + rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n") + "\r\n";
}

export function serializeConfigTable(records) {
  return csv(configTableRows(records));
}

export function configTableRows(records) {
  validateConfigList(records);
  const ids = new Set();
  return [[...CONFIG_TABLE_HEADERS, ...CONFIG_TABLE_OPTIONAL_HEADERS], ...records.map((record, index) => {
    const { config } = record;
    const id = record.levelId ?? String(index + 1);
    if (ids.has(id)) throw new Error(`关卡 id「${id}」重复，请先调整配置列表。`);
    ids.add(id);
    const words = normalizeFixedWords(config.fixedWords);
    if (words.length > 2) throw new Error(`第 ${index + 1} 关超过两个初始单词，无法导出到此配置表。`);
    return [id, `${config.columns}x${config.rows}`, words[0] ?? "", words[1] ?? "", ...["scope", "emotion", "rarityLevel"]
      .map(field => JSON.stringify(config.filters[field] ?? CONFIG_FILTER_OPTIONS[field])), config.targetDuplicateRange, config.desiredTargetCount ?? 0];
  })];
}

export function configTableTemplate() {
  return csv(configTableTemplateRows());
}

export function configTableTemplateRows() {
  return [[...CONFIG_TABLE_HEADERS, ...CONFIG_TABLE_OPTIONAL_HEADERS], ["001", "3x3", "CAT", "DOG", "[0,1,2,3,4]", "[-2,-1,0,1,2]", "[1,2,3,4,5]", 50, 0]];
}
