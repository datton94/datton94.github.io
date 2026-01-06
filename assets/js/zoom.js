document.addEventListener("DOMContentLoaded", function () {
  if (typeof mediumZoom !== "function") {
    console.log("mediumZoom not loaded");
    return;
  }

  const selector = 'img[src^="/images/"]:not([data-no-zoom])';

  const zoom = mediumZoom(selector, {
    margin: 24,
    scrollOffset: 0,
    background: "rgba(0,0,0,0.85)",
  });

  let openedEl = null;
  let toggleBtn = null;

  const LEVELS = [1, 1.5, 2];
  let levelIndex = 0;

  // drag state
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;

  // Apply and remove root fixes so fixed positioning uses real viewport
  const root = document.documentElement;
  const body = document.body;

  function setImp(el, prop, val) {
    el.style.setProperty(prop, val, "important");
  }
  function rm(el, prop) {
    el.style.removeProperty(prop);
  }

  function rootFixOn() {
    root.classList.add("mz-root-open");

    // kill centered body layout + flicker effects during zoom
    setImp(body, "margin", "0");
    setImp(body, "max-width", "none");
    setImp(body, "width", "100%");
    setImp(body, "animation", "none");
    setImp(body, "transform", "none");
    setImp(body, "filter", "none");
    setImp(body, "overflow", "hidden");

    setImp(root, "animation", "none");
    setImp(root, "transform", "none");
    setImp(root, "filter", "none");
  }

  function rootFixOff() {
    root.classList.remove("mz-root-open");

    ["margin", "max-width", "width", "animation", "transform", "filter", "overflow"].forEach((p) =>
      rm(body, p)
    );
    ["animation", "transform", "filter"].forEach((p) => rm(root, p));
  }

  function pxVar(el, name) {
    const v = el.style.getPropertyValue(name);
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  function setPan(el, x, y) {
    el.style.setProperty("--mz-x", `${x}px`);
    el.style.setProperty("--mz-y", `${y}px`);
  }

  function setZoomLevel(level) {
    if (!openedEl) return;

    openedEl.style.setProperty("--mz-scale", String(level));
    if (toggleBtn) toggleBtn.textContent = `${level}x`;

    if (level > 1) {
      openedEl.classList.add("mz-pan");
    } else {
      openedEl.classList.remove("mz-pan");
      setPan(openedEl, 0, 0);
    }
  }

  function cycleZoom() {
    levelIndex = (levelIndex + 1) % LEVELS.length;
    setZoomLevel(LEVELS[levelIndex]);
  }

  function onPointerDown(e) {
    if (!openedEl) return;
    const current = parseFloat(openedEl.style.getPropertyValue("--mz-scale")) || 1;
    if (current <= 1) return;

    e.preventDefault();
    e.stopPropagation();

    dragging = false;
    startX = e.clientX;
    startY = e.clientY;
    baseX = pxVar(openedEl, "--mz-x");
    baseY = pxVar(openedEl, "--mz-y");

    openedEl.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!openedEl) return;
    if (!openedEl.hasPointerCapture(e.pointerId)) return;

    const current = parseFloat(openedEl.style.getPropertyValue("--mz-scale")) || 1;
    if (current <= 1) return;

    e.preventDefault();
    e.stopPropagation();

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (Math.abs(dx) + Math.abs(dy) > 3) dragging = true;

    setPan(openedEl, baseX + dx, baseY + dy);
  }

  function onPointerUp(e) {
    if (!openedEl) return;
    if (openedEl.hasPointerCapture(e.pointerId)) openedEl.releasePointerCapture(e.pointerId);

    if (dragging) {
      e.preventDefault();
      e.stopPropagation();
    }
    dragging = false;
  }

  function createToggleButton() {
    toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "mz-zoom-toggle";
    toggleBtn.textContent = "1x";

    toggleBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!openedEl) return;
      cycleZoom();
    });

    document.body.appendChild(toggleBtn);
  }

  function removeToggleButton() {
    if (toggleBtn) toggleBtn.remove();
    toggleBtn = null;
  }

  function attachOpened(el) {
    openedEl = el;
    openedEl.classList.add("mz-fixed");
    openedEl.setAttribute("draggable", "false");

    // default 1x
    levelIndex = 0;
    setZoomLevel(LEVELS[levelIndex]);

    // Stop close while zoomed and user clicks on image
    openedEl.addEventListener(
      "click",
      function (e) {
        const current = parseFloat(openedEl.style.getPropertyValue("--mz-scale")) || 1;
        if (current > 1) e.stopPropagation();
      },
      true
    );

    openedEl.addEventListener("pointerdown", onPointerDown);
    openedEl.addEventListener("pointermove", onPointerMove);
    openedEl.addEventListener("pointerup", onPointerUp);
    openedEl.addEventListener("pointercancel", onPointerUp);

    createToggleButton();
  }

  function cleanupOpened() {
    if (openedEl) {
      openedEl.classList.remove("mz-fixed", "mz-pan");
      openedEl.style.removeProperty("--mz-scale");
      openedEl.style.removeProperty("--mz-x");
      openedEl.style.removeProperty("--mz-y");
      openedEl.removeAttribute("draggable");

      openedEl.removeEventListener("pointerdown", onPointerDown);
      openedEl.removeEventListener("pointermove", onPointerMove);
      openedEl.removeEventListener("pointerup", onPointerUp);
      openedEl.removeEventListener("pointercancel", onPointerUp);
    }
    openedEl = null;
    removeToggleButton();
  }

  function findOpenedClone() {
    return document.querySelector(
      "img.medium-zoom-image--open, img.medium-zoom-image--opened"
    );
  }

  zoom.on("open", () =>
    requestAnimationFrame(() => {
      const el = findOpenedClone();
      if (el) attachOpened(el);
    })
  );

  zoom.on("opened", () => {
    const el = findOpenedClone();
    if (el && el !== openedEl) attachOpened(el);
  });

  zoom.on("close", () => {
    cleanupOpened();
    rootFixOff();
  });
  zoom.on("closed", () => {
    cleanupOpened();
    rootFixOff();
  });

  // Intercept click before medium zoom handler:
  // enable root fix BEFORE open so geometry is correct on mobile
  document.addEventListener(
    "click",
    function (e) {
      if (document.body.classList.contains("medium-zoom--opened")) return;

      const img = e.target && e.target.closest ? e.target.closest(selector) : null;
      if (!img) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      rootFixOn();

      // force reflow
      void document.body.offsetHeight;

      requestAnimationFrame(() => {
        zoom.open({ target: img });
      });
    },
    true
  );
});
