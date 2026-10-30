export function renderWordLetters(element, word) {
  element.classList.add("word-letters");
  element.title = word;
  element.replaceChildren(...Array.from(word, letter => {
    const tile = document.createElement("span");
    tile.className = "word-letter";
    tile.textContent = letter;
    return tile;
  }));
}
