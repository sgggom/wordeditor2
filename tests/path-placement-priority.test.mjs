import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerator } from '../dist/level-generator.js';
import { describePath } from '../dist/level-statistics.js';

function randomFrom(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Independent oracle: enumerate all legal routes and score completed paths
// using the same public scoring rule that the editor displays.
function enumerate({ rows, columns, letters, disabledCells = [], fixedWord }, words) {
  const placements = [], disabled = new Set(disabledCells);
  for (const word of words.filter(word => !fixedWord || word === fixedWord)) {
    function visit(path) {
      if (path.length === word.length) {
        placements.push({ word, path: [...path], added: path.filter(cell => !letters[cell]).length,
          score: describePath(path, columns).difficultyScore });
        return;
      }
      for (let cell = 0; cell < rows * columns; cell++) {
        if (disabled.has(cell) || path.includes(cell) || letters[cell] && letters[cell] !== word[path.length]) continue;
        const last = path.at(-1);
        if (last !== undefined && Math.abs(Math.floor(last / columns) - Math.floor(cell / columns)) + Math.abs(last % columns - cell % columns) !== 1) continue;
        visit([...path, cell]);
      }
    }
    visit([]);
  }
  return placements.filter(entry => entry.added > 0 || fixedWord);
}

test('a zero-score straight route wins even when reverse direction is configured as 100 percent preferred', () => {
  const generator = createGenerator([{ word: 'ABC' }]);
  for (let seed = 1; seed <= 20; seed++) {
    const placement = generator.findPlacement({ rows: 3, columns: 3, letters: Array(9).fill(''),
      initialForwardProbability: 0, random: randomFrom(seed) });
    assert.equal(describePath(placement.path, 3).difficultyScore, 0);
  }
});

test('automatic placement matches exhaustive coverage and score optima across partial boards, shapes and fixed words', () => {
  const words = ['ABC', 'CBA', 'ABCD', 'ABCDE', 'ABCDEF', 'BEAD'];
  const generator = createGenerator(words.map(word => ({ word })));
  for (let seed = 1; seed <= 32; seed++) {
    const random = randomFrom(seed);
    const options = { rows: seed % 2 ? 2 : 3, columns: 3,
      disabledCells: seed % 4 === 0 ? [0, 8] : [], initialForwardProbability: seed % 3 ? 0 : 100,
      fixedWord: seed % 5 === 0 ? 'ABC' : null, random };
    options.letters = Array.from({ length: options.rows * options.columns }, () => ['', '', 'A', 'B', 'C'][Math.floor(random() * 5)]);
    const choices = enumerate(options, words);
    const actual = generator.findPlacement(options);
    if (!choices.length) { assert.equal(actual, null); continue; }
    const mostAdded = Math.max(...choices.map(entry => entry.added));
    const bestScore = Math.min(...choices.filter(entry => entry.added === mostAdded).map(entry => entry.score));
    assert.equal(actual.path.filter(cell => !options.letters[cell]).length, mostAdded, `coverage seed ${seed}`);
    assert.equal(describePath(actual.path, 3).difficultyScore, bestScore, `score seed ${seed}`);
    assert.ok(choices.some(entry => entry.word === actual.word && entry.path.join(',') === actual.path.join(',')));
  }
});

test('equally simple placements remain varied across random seeds', () => {
  const generator = createGenerator([{ word: 'ABC' }]);
  const paths = new Set(Array.from({ length: 20 }, (_, seed) => generator.findPlacement({
    rows: 3, columns: 3, letters: Array(9).fill(''), random: randomFrom(seed + 1),
  }).path.join(',')));
  assert.ok(paths.size > 1);
});
