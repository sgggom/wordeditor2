// Exhaustive target-answer analysis. Extra words never enter this simulation.
export function analyzeTargetPaths({ rows, columns, cells, targetWords = [], disabledCells = [] }) {
  if (![2, 3, 4, 5].includes(rows) || ![2, 3, 4, 5].includes(columns) || cells?.length !== rows * columns) {
    throw new Error("目标路径检测的棋盘尺寸无效。");
  }
  const disabled = new Set(disabledCells);
  const counts = cells.map((cell, index) => {
    const blocked = disabled.has(index) || cell.disabled;
    if (!Number.isSafeInteger(cell.count) || cell.count < 0 || (blocked && cell.count !== 0) ||
        (cell.count > 0 && !/^[A-Z]$/.test(cell.letter))) throw new Error("目标路径检测的格子次数或字母无效。");
    return blocked ? 0 : cell.count;
  });
  const words = targetWords.map(entry => entry.word);
  if (new Set(words).size !== words.length || words.some(word => !/^[A-Z]+$/.test(word))) throw new Error("目标答案无效或重复。");
  const neighbors = cells.map((_, cell) => [
    ...(cell >= columns ? [cell - columns] : []),
    ...(cell + columns < cells.length ? [cell + columns] : []),
    ...(cell % columns ? [cell - 1] : []),
    ...(cell % columns < columns - 1 ? [cell + 1] : []),
  ]);
  let legalPathCount = 0;
  const paths = words.map(word => {
    const effects = new Set();
    function* visit(cell, step, used, path) {
      if (!counts[cell] || cells[cell].letter !== word[step]) return;
      used |= 1 << cell;
      path.push(cell);
      if (step + 1 === word.length) {
        legalPathCount++;
        // Different connection orders over the same cells consume the same
        // counts, so their subsequent game states are identical.
        if (!effects.has(used)) { effects.add(used); yield [...path]; }
      } else for (const next of neighbors[cell]) if (!(used & (1 << next))) yield* visit(next, step + 1, used, path);
      path.pop();
    }
    function* walk() {
      for (let cell = 0; cell < cells.length; cell++) yield* visit(cell, 0, 0, []);
    }
    const iterator = walk();
    const source = { cached: [], done: false, *options() {
      let index = 0;
      while (true) {
        if (index < source.cached.length) yield source.cached[index++];
        else if (source.done) return;
        else {
          const next = iterator.next();
          if (next.done) { source.done = true; return; }
          source.cached.push(next.value);
        }
      }
    } };
    return source;
  });
  const all = (1n << BigInt(words.length)) - 1n;
  const bit = index => 1n << BigInt(index);
  const available = (path, remainingCounts) => path.every(cell => remainingCounts[cell] > 0);
  function* choicesFor(index, remainingCounts) {
    for (const path of paths[index].options()) if (available(path, remainingCounts)) yield path;
  }
  const consume = (path, remainingCounts) => {
    const next = [...remainingCounts];
    for (const cell of path) next[cell]--;
    return next;
  };
  const keyFor = (remaining, remainingCounts) => `${remaining}:${remainingCounts.join(",")}`;
  const solutionMemo = new Map();
  function canComplete(remaining, remainingCounts) {
    const key = keyFor(remaining, remainingCounts);
    if (solutionMemo.has(key)) return solutionMemo.get(key);
    if (!remaining) return remainingCounts.every(count => count === 0);
    let chosen = -1;
    let required = 0;
    for (let index = 0; index < words.length; index++) {
      if (!(remaining & bit(index))) continue;
      required += words[index].length;
      if (choicesFor(index, remainingCounts).next().done) { solutionMemo.set(key, false); return false; }
      if (chosen < 0 || words[index].length > words[chosen].length) chosen = index;
    }
    if (required !== remainingCounts.reduce((sum, count) => sum + count, 0)) { solutionMemo.set(key, false); return false; }
    // To find an assignment, target order does not matter: consumption commutes.
    // Trying longer targets first changes no possible solutions. Routes are
    // discovered lazily so an early problem does not enumerate unrelated paths.
    for (const path of choicesFor(chosen, remainingCounts)) {
      if (canComplete(remaining ^ bit(chosen), consume(path, remainingCounts))) {
        solutionMemo.set(key, true); return true;
      }
    }
    solutionMemo.set(key, false);
    return false;
  }
  const safeStates = new Set();
  function findTrap(remaining, remainingCounts) {
    const key = keyFor(remaining, remainingCounts);
    if (!remaining || safeStates.has(key)) return null;
    const options = [];
    for (let index = 0; index < words.length; index++) {
      if (remaining & bit(index)) options.push(index);
    }
    // This state is known solvable. If every remaining target has a single
    // consumption effect, every order reaches that same complete assignment.
    if (options.every(index => paths[index].done && paths[index].cached.filter(path => available(path, remainingCounts)).length === 1)) {
      safeStates.add(key); return null;
    }
    // Inspect every currently playable target, every distinct path effect and
    // every subsequent state. Stop only after an actual unfinishable choice.
    for (const index of options) for (const path of choicesFor(index, remainingCounts)) {
      const nextCounts = consume(path, remainingCounts), next = remaining ^ bit(index);
      const move = { word: words[index], path: [...path] };
      if (!canComplete(next, nextCounts)) return {
        moves: [move], remainingWords: words.filter((_, other) => next & bit(other)), counts: nextCounts,
      };
      const trap = findTrap(next, nextCounts);
      if (trap) return { ...trap, moves: [move, ...trap.moves] };
    }
    safeStates.add(key);
    return null;
  }
  const solvable = canComplete(all, counts);
  const counterexample = solvable ? findTrap(all, counts) : null;
  return { solvable, allChoicesComplete: solvable && !counterexample, counterexample,
    legalPathCount, distinctPathCount: paths.reduce((sum, source) => sum + source.cached.length, 0),
    pathsExhausted: paths.every(source => source.done) };
}
