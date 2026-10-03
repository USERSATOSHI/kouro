(() => {
  const script = document.currentScript;
  if (!script) return;
  const root = new URL("../../", script.src);
  const nav = document.createElement("nav");
  nav.className = "kouro-api-nav";
  nav.setAttribute("aria-label", "Kouro documentation");
  for (const [label, path] of [
    ["kouro", "index.html"],
    ["Learn", "guide.html"],
    ["Examples", "examples.html"],
    ["API reference", "api/index.html"],
  ]) {
    const link = document.createElement("a");
    link.textContent = label;
    link.href = new URL(path, root).href;
    nav.append(link);
  }
  document.body.prepend(nav);
  // A same-page method result changes the hash without loading a new page.
  // Close the native dialog so the selected method and navigation are usable.
  document.getElementById("tsd-search-results")?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("a[href]")) return;
    const dialog = document.getElementById("tsd-search");
    // Let TypeDoc remove its overlay and restore scrolling as well as closing.
    if (dialog instanceof HTMLDialogElement && dialog.open)
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
})();
