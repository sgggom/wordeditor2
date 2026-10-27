import { TARGET_LENGTH_OPTIONS } from "./level-config.js";

export function renderTargetPlanChoices(container, plan, prefix = "target-plan") {
  const fragment = document.createDocumentFragment();
  plan.forEach((group, index) => {
    const row = document.createElement("div");
    row.className = "target-plan-row";
    const label = document.createElement("span");
    label.id = `${prefix}-label-${index}`;
    label.textContent = `第 ${index + 1} 个`;
    const choices = document.createElement("div");
    choices.className = "target-plan-choices";
    choices.setAttribute("role", "radiogroup");
    choices.setAttribute("aria-labelledby", label.id);
    for (const [value, title] of Object.entries(TARGET_LENGTH_OPTIONS)) {
      const option = document.createElement("label");
      option.className = "target-plan-option";
      option.title = title;
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `${prefix}-${index}`;
      input.value = value;
      input.dataset.targetIndex = String(index);
      input.checked = value === group;
      input.setAttribute("aria-label", title);
      const surface = document.createElement("span");
      surface.className = "target-plan-option-surface";
      const [name, length] = title.split(" · ");
      const text = document.createElement("strong");
      text.textContent = name;
      const detail = document.createElement("span");
      detail.textContent = length.replace("5 字母及以上", "5+ 字母");
      surface.append(text, detail);
      option.append(input, surface);
      choices.append(option);
    }
    row.append(label, choices);
    fragment.append(row);
  });
  container.replaceChildren(fragment);
}
