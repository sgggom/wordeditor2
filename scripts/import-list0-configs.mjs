import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildList0ConfigPreset } from "../dist/reference-config.js";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("请提供 wt_level_list_0_解码.json 的路径。");
const source = await readFile(sourcePath);
const preset = buildList0ConfigPreset(JSON.parse(source));
preset.source = { file: "wt_level_list_0_解码.json", sha256: createHash("sha256").update(source).digest("hex") };
await writeFile(new URL("../dist/data/list0-configs.json", import.meta.url), JSON.stringify(preset) + "\n");
console.log(`已生成 ${preset.records.length} 关配置；初始长度例外 ${preset.initialLengthExceptions.length} 关，最长词截至 8 字母 ${preset.longestWordExceptions.length} 关。`);
