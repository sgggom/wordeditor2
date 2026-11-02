import * as XLSX from "./vendor/sheetjs/xlsx.js";
import { configTableRows, configTableTemplateRows, parseConfigTableRows } from "./config-table.js";
import { MAX_CONFIG_ROWS } from "./level-config.js";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function parseConfigXlsx(data, defaults) {
  const signature = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  if (signature?.[0] !== 80 || signature?.[1] !== 75) throw new Error("Excel 文件读取失败，请使用有效的 .xlsx 文件。");
  let workbook;
  try { workbook = XLSX.read(data, { type: "array" }); }
  catch { throw new Error("Excel 文件读取失败，请使用有效的 .xlsx 文件。"); }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet?.["!ref"]) throw new Error("Excel 第一个工作表中没有关卡数据。");
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  if (range.e.c > 50) throw new Error(`配置表最多支持 ${MAX_CONFIG_ROWS} 关和七个参数列，请清除多余行列。`);
  // Start at A1 to preserve spreadsheet row numbers in validation errors.
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "", blankrows: true,
    range: { s: { r: 0, c: 0 }, e: range.e } });
  // Excel/WPS can retain formatting far below the last actual level.
  while (rows.length && rows.at(-1).every(value => !String(value).trim())) rows.pop();
  if (rows.length > MAX_CONFIG_ROWS + 1) throw new Error(`配置表最多支持 ${MAX_CONFIG_ROWS} 关和七个参数列，请清除多余行列。`);
  const columnCount = rows[0]?.some(value => String(value).trim() === "目标重复检测") ? 8 : 7;
  for (const row of rows) {
    while (row.length > columnCount && !String(row.at(-1)).trim()) row.pop();
    while (row.length < columnCount) row.push("");
  }
  return parseConfigTableRows(rows, defaults);
}

function writeWorkbook(rows) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [16, 64, 18, 18, 24, 26, 26].map(wch => ({ wch }));
  sheet["!rows"] = rows.map(() => ({ hpt: 24 }));
  sheet["!autofilter"] = { ref: sheet["!ref"] };
  // Write literal text, preserving leading zeroes and array notation in Excel/WPS.
  for (const [address, cell] of Object.entries(sheet)) {
    if (!address.startsWith("!")) cell.z = "@";
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "关卡配置");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true });
}

export function serializeConfigXlsx(records) {
  return writeWorkbook(configTableRows(records));
}

export function configXlsxTemplate() {
  return writeWorkbook(configTableTemplateRows());
}
