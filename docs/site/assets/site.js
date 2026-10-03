document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.textContent);
      button.textContent = "Copied";
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(source);
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = "Selected — copy with keyboard";
    }
    window.setTimeout(() => {
      button.textContent = "Copy";
    }, 2400);
  });
});
const search = document.querySelector("#example-search");
if (search) {
  const items = Array.from(document.querySelectorAll("[data-example]"));
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    for (const item of items) {
      item.hidden = !item.textContent.toLowerCase().includes(query);
      if (!item.hidden) visible++;
    }
    document.querySelector("#search-status").textContent =
      `${visible} example${visible === 1 ? "" : "s"}`;
  });
}
