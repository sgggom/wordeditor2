export const normalizeLatinWordInput = value => String(value).normalize("NFKC").replace(/\s/g, "*").replace(/[^A-Za-z*]/g, "");

// Keep raw Latin letters when an IME supplies Process/229 keyboard events.
// Composition text is only a fallback for input methods without physical key
// codes; a committed Chinese candidate never replaces the Latin search value.
export function bindLatinWordInput(input, onChange) {
  let value = normalizeLatinWordInput(input.value), start = value.length, end = start;
  let composing = false, rawComposition = false, base = null, internal = false, lastRawKey = -Infinity;
  function selection() {
    if (input.value === value) { start = input.selectionStart ?? start; end = input.selectionEnd ?? end; }
  }
  function restore() {
    if (input.value !== value) input.value = value;
    input.setSelectionRange(start, end);
  }
  function publish() {
    restore();
    internal = true;
    try { input.dispatchEvent(new Event("input", { bubbles: true })); }
    finally { internal = false; }
  }
  function insert(text) {
    selection();
    value = value.slice(0, start) + text + value.slice(end);
    start += text.length; end = start;
    publish();
  }
  function keydown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const ime = composing || event.isComposing || event.key === "Process" || event.keyCode === 229;
    if (!ime) {
      if (event.key.length === 1 && /[^A-Za-z*\s]/.test(event.key)) event.preventDefault();
      return;
    }
    let text = /^[A-Za-z]$/.test(event.key) ? event.key : null;
    if (text === null && /^Key[A-Z]$/.test(event.code)) {
      const upper = Boolean(event.shiftKey) !== Boolean(event.getModifierState?.("CapsLock"));
      text = upper ? event.code.slice(3) : event.code.slice(3).toLowerCase();
    }
    if (event.key === " " || event.code === "Space" || event.key === "*" || (event.shiftKey && event.code === "Digit8")) text = "*";
    if (text !== null) {
      event.preventDefault(); rawComposition = true; lastRawKey = performance.now(); insert(text);
    } else if (["Backspace", "Delete"].includes(event.code)) {
      event.preventDefault(); rawComposition = true; selection();
      if (start === end) {
        if (event.code === "Backspace") start = Math.max(0, start - 1);
        else end = Math.min(value.length, end + 1);
      }
      value = value.slice(0, start) + value.slice(end);
      end = start; publish();
    }
  }
  function compositionStart() {
    selection(); composing = true;
    rawComposition = performance.now() - lastRawKey < 100;
    base = { value, start, end };
  }
  function compositionUpdate(event) {
    if (!composing || rawComposition || !base) return;
    const text = normalizeLatinWordInput(event.data ?? "");
    if (!text) return;
    value = base.value.slice(0, base.start) + text + base.value.slice(base.end);
    start = end = base.start + text.length;
    restore(); onChange();
  }
  function compositionEnd() {
    composing = false; rawComposition = false; base = null;
    restore(); onChange();
  }
  function changed(event) {
    if (internal) { onChange(); return; }
    if (/^(?:insertFromPaste|insertFromDrop|history|delete)/.test(event.inputType ?? "")) {
      composing = false; rawComposition = false; base = null;
    }
    // Discard an IME's committed candidate while retaining its original letters.
    if (/^insert(?:Text|FromComposition)$/.test(event.inputType ?? "") && event.data && /[^A-Za-z*\s]/.test(event.data)) {
      composing = false; rawComposition = false; base = null;
      restore(); onChange(); return;
    }
    if (composing || event.isComposing) { restore(); return; }
    const next = input.value;
    start = normalizeLatinWordInput(next.slice(0, input.selectionStart ?? next.length)).length;
    end = normalizeLatinWordInput(next.slice(0, input.selectionEnd ?? next.length)).length;
    value = normalizeLatinWordInput(next);
    rawComposition = false;
    restore(); onChange();
  }
  const events = { keydown, compositionstart: compositionStart, compositionupdate: compositionUpdate,
    compositionend: compositionEnd, input: changed };
  for (const [name, listener] of Object.entries(events)) input.addEventListener(name, listener);
  return () => { for (const [name, listener] of Object.entries(events)) input.removeEventListener(name, listener); };
}
