function validateRanges(ranges) {
  for (const kind of ['target', 'extra']) {
    if (!Number.isSafeInteger(ranges?.[kind]) || ranges[kind] < 0) {
      throw new Error('单词冷却范围须为大于或等于 0 的整数。');
    }
  }
}

function names(entries = []) {
  if (!Array.isArray(entries)) throw new Error('冷却记录需要单词列表。');
  return entries.map(entry => {
    const word = entry?.word?.trim().toUpperCase();
    if (!word || !/^[A-Z]+$/.test(word)) throw new Error('冷却记录中的单词无效。');
    return word;
  });
}

// A word's last accepted position is equivalent to two countdowns. Reading or
// rejecting a candidate does not advance them. Every occurrence resets both.
export function createWordCooldown(ranges, saved = null) {
  validateRanges(ranges);
  const limits = { target: ranges.target, extra: ranges.extra };
  let completed = 0;
  const lastSeen = new Map();
  const undo = [];
  if (saved !== null) {
    if (saved?.version !== 1 || !Number.isSafeInteger(saved.completed) || saved.completed < 0 ||
        saved.ranges?.target !== limits.target || saved.ranges?.extra !== limits.extra ||
        !Array.isArray(saved.lastSeen)) {
      throw new Error('单词冷却快照无效或范围不一致。');
    }
    completed = saved.completed;
    for (const entry of saved.lastSeen) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error('单词冷却快照无效。');
      const [word, position] = entry;
      if (typeof word !== 'string' || !/^[A-Z]+$/.test(word) || lastSeen.has(word) ||
          !Number.isSafeInteger(position) || position < 1 || position > completed) {
        throw new Error('单词冷却快照无效。');
      }
      lastSeen.set(word, position);
    }
  }

  function remaining(word) {
    const normalized = names([{ word }])[0];
    const last = lastSeen.get(normalized);
    const age = last === undefined ? Infinity : completed - last;
    return { target: Math.max(0, limits.target - age), extra: Math.max(0, limits.extra - age) };
  }

  function blockedWords() {
    const blocked = { target: [], extra: [] };
    for (const [word, position] of lastSeen) {
      const age = completed - position;
      if (age < limits.target) blocked.target.push(word);
      if (age < limits.extra) blocked.extra.push(word);
    }
    return blocked;
  }

  function check(level) {
    return Object.fromEntries(['target', 'extra'].map(kind => [kind,
      [...new Set(names(level?.[kind + 'Words']))].filter(word => remaining(word)[kind] > 0),
    ]));
  }

  return {
    remaining,
    blockedWords,
    check,
    commit(level) {
      const targets = names(level?.targetWords);
      const extras = names(level?.extraWords);
      const duplicates = check(level);
      if (duplicates.target.length || duplicates.extra.length) {
        const error = new Error('候选关卡使用了冷却中的单词。');
        error.code = 'WORD_COOLDOWN';
        error.duplicates = duplicates;
        throw error;
      }
      if (!Number.isSafeInteger(completed + 1)) throw new Error('已完成关卡数超出范围。');
      const changed = [...new Set([...targets, ...extras])].map(word => [word, lastSeen.get(word)]);
      undo.push(changed);
      completed++;
      for (const [word] of changed) lastSeen.set(word, completed);
    },
    rollback() {
      const changed = undo.pop();
      if (!changed) throw new Error('没有可回退的冷却记录。');
      for (const [word, previous] of changed) {
        if (previous === undefined) lastSeen.delete(word);
        else lastSeen.set(word, previous);
      }
      completed--;
    },
    snapshot() {
      return { version: 1, ranges: { ...limits }, completed, lastSeen: [...lastSeen] };
    },
  };
}
