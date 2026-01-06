(function () {
  function wrapTables() {
    const tables = document.querySelectorAll("table");
    let wrapped = 0;

    tables.forEach((table) => {
      // Skip already wrapped tables
      if (table.closest(".table-scroll")) return;

      // Skip medium-zoom internal stuff (just in case)
      if (table.closest(".medium-zoom-overlay")) return;

      const wrap = document.createElement("div");
      wrap.className = "table-scroll";

      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
      wrapped += 1;
    });

    // Debug (remove later if you want)
    console.log("[table-scroll] tables:", tables.length, "wrapped:", wrapped);
  }

  // Expose for debugging in DevTools Console
  window.wrapTables = wrapTables;

  // Run multiple times to catch late-rendered content (some themes do this)
  function run() {
    wrapTables();
    setTimeout(wrapTables, 50);
    setTimeout(wrapTables, 300);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }

  // Extra safety: if content changes later, wrap new tables too
  const obs = new MutationObserver(() => wrapTables());
  obs.observe(document.body, { childList: true, subtree: true });
})();
