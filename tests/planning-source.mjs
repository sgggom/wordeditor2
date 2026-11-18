import { readFileSync } from "node:fs";

const repository = new URL("../", import.meta.url);
const fixtures = new URL("./fixtures/", import.meta.url);

export function readPlanningSource(path) {
  if (path.startsWith("level-editor/")) {
    return readFileSync(new URL(path.slice("level-editor/".length), repository));
  }
  if (path.startsWith("outputs/")) {
    return readFileSync(new URL(path, fixtures));
  }
  throw new Error(`Unknown planning source: ${path}`);
}
