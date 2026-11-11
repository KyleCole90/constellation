// Runs in the page after every screenshot, at the shot's width and at 1180. Reads computed styles and real hit-testing, not class names.
export const CATEGORIES = [
  "font",
  "button",
  "clipped",
  "overlap",
  "occluded",
  "hidden",
  "cut",
  "inset",
  "edge",
  "rowHeight",
  "banner",
];

const MEASURED = {
  sidebarRow: '[data-testid="sidebar"] li a',
  sidebarSub: '[data-testid="setup-offer"] span, [data-testid="setup-offers-toggle"] span',
  composerChip: "div:has(> div > textarea[data-composer]) > div:first-child button",
  composer: "textarea[data-composer]",
  queueRow: '[data-testid="queue-list"] [data-row]',
  queueTitle: '[data-testid="queue-list"] [data-row] button span span',
  queueChip: '[data-testid="pinned-queue"] button[aria-pressed]',
  queueSelectionBar: '[data-testid="pinned-queue"] > div:last-child',
  inboxRow: '[data-testid="inbox-list"] [data-row]',
  inboxChip: '[data-testid="inbox-list"] button[aria-pressed]',
  findingRow: '[data-testid="finding-row"]',
  gradebookStudent: "th[data-first-col]",
  gradebookTotal: "td[data-total]",
  dueRow: '[data-testid="due-list"] li',
  setupOfferDue: '[data-testid="setup-offer"][data-surface="due"]',
  shiftCell: '[data-testid="shift-row"] td',
  dateInput: 'input[type="date"]',
  textInput: 'input[type="text"],input[type="password"],input:not([type])',
  banner: "[data-banner]",
  badge: '[data-slot="badge"]',
  button: "button[data-slot=button]:not([aria-label])",
  iconButton: "button[data-slot=button][aria-label]",
  tab: "[role=tab]",
  screenHeader: '[data-testid="screen-header"]',
  focusedCard: "[data-focused]",
  chatText: '[data-testid="chat"] p',
  reading: ".paper",
  threadMain: '[data-testid="thread-main"]',
  threadPanel: '[data-testid="thread-panel"]',
  inboxList: '[data-testid="inbox-list"]',
};

export const AUDIT_PAGE = String.raw`(() => {
  const BUTTONS = { 28: 10, 32: 12, 36: 16 };
  const MIN_FONT = 12;
  const MIN_INSET = 12;
  const MIN_WINDOW_EDGE = 16;
  const MIN_READABLE_TRUNCATION = 48;
  const OVERLAP_SHARE = 0.4;
  const PROBLEMS = [
    ["token", /token|reconnect|expired/i],
    ["conflict", /changed in the lms|conflict/i],
    ["partial", /not written|some of|partly/i],
    ["rejected", /rejected|refused|wouldn.t accept/i],
    ["in-doubt", /in doubt|couldn.t confirm|may have/i],
    ["rate", /rate limit|too many|retries/i],
    ["interrupted", /interrupted|didn.t finish/i],
    ["failed", /^failed |ran out of tries/i],
    ["approval-reset", /approval (was )?reset|needs (your|a fresh) approval/i],
  ];

  const found = Object.fromEntries(${JSON.stringify(CATEGORIES)}.map((name) => [name, []]));
  const census = { font: {}, button: {}, truncated: [], exemptRows: 0 };
  const flag = (category, detail) => { if (!found[category].includes(detail)) found[category].push(detail); };
  const clean = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  const describe = (el) => {
    const id = el.getAttribute?.("data-testid") ?? el.getAttribute?.("data-banner") ?? el.getAttribute?.("aria-label");
    return el.tagName.toLowerCase() + (id ? "[" + id + "]" : "") + (clean(el.textContent) ? ' "' + clean(el.textContent).slice(0, 36) + '"' : "");
  };
  const styleOf = (el) => getComputedStyle(el);
  const hiddenStyle = (el) => { const s = styleOf(el); return s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0; };
  const visuallyHidden = (el) => { const r = el.getBoundingClientRect(); return r.width <= 1 && r.height <= 1; };
  const shown = (el) => {
    if (!el.isConnected || visuallyHidden(el)) return false;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (hiddenStyle(node)) return false;
      if (node.parentElement?.matches("details:not([open])") && node.tagName !== "SUMMARY") return false;
    }
    return true;
  };
  const near = (el, other) => el === other || el.contains(other) || other.contains(el);
  const isScroller = (el, axis) => { const v = axis === "x" ? styleOf(el).overflowX : styleOf(el).overflowY; return v === "auto" || v === "scroll"; };
  const ancestors = (el) => { const out = []; for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) out.push(node); return out; };
  const scrollersOf = (el) => ancestors(el).filter((node) => isScroller(node, "y") || isScroller(node, "x"));
  const alphaOf = (color) => { const m = color.match(/rgba?\(([^)]+)\)/); if (!m) return color === "transparent" ? 0 : 1; const parts = m[1].split(/[ ,/]+/); return parts.length > 3 ? Number(parts[3]) : 1; };
  const paintsOver = (el) => alphaOf(styleOf(el).backgroundColor) > 0.9;
  const stickyBetween = (el, boundary) => { for (let node = el; node && node !== boundary; node = node.parentElement) if (styleOf(node).position === "sticky") return true; return false; };
  // A toast covers what's under it only until it times out or is dismissed.
  const isScrim = (el) => Boolean(el.closest?.("[data-scrim],[data-toast]"));
  const inModal = (el) => Boolean(el.closest?.("[role=dialog],[role=alertdialog],[data-scrim]"));
  const openScrim = [...document.querySelectorAll(".thread-scrim")].find((el) => getComputedStyle(el).display !== "none");
  const behindScrim = (el) => Boolean(openScrim?.parentElement.contains(el) && !el.closest('[data-testid="thread-panel"]'));

  // The visible part of a box after its overflow ancestors and the viewport.
  const visibleBox = (rect, el, clipSelf = false) => {
    let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
    for (const node of clipSelf ? [el, ...ancestors(el)] : ancestors(el)) {
      const s = styleOf(node);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const r = node.getBoundingClientRect();
      if (s.overflowX !== "visible") { left = Math.max(left, r.left + node.clientLeft); right = Math.min(right, r.left + node.clientLeft + node.clientWidth); }
      if (s.overflowY !== "visible") { top = Math.max(top, r.top + node.clientTop); bottom = Math.min(bottom, r.top + node.clientTop + node.clientHeight); }
    }
    left = Math.max(left, 0); top = Math.max(top, 0); right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight);
    return right > left && bottom > top ? { left, right, top, bottom, width: right - left, height: bottom - top } : null;
  };

  const runs = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!clean(node.nodeValue)) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest("script,style,noscript") || !shown(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    if (rects.length) runs.push({ node, parent, rects, text: clean(node.nodeValue) });
  }

  for (const run of runs) {
    const s = styleOf(run.parent);
    const size = parseFloat(s.fontSize);
    const key = size + "/" + (s.lineHeight === "normal" ? "normal" : parseFloat(s.lineHeight));
    census.font[key] = (census.font[key] ?? 0) + 1;
    if (size < MIN_FONT) flag("font", size + "px " + describe(run.parent));
  }
  for (const field of document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=hidden]),textarea,select")) {
    if (!shown(field)) continue;
    const size = parseFloat(styleOf(field).fontSize);
    census.font[size + "/field"] = (census.font[size + "/field"] ?? 0) + 1;
    if (size < MIN_FONT) flag("font", size + "px " + describe(field));
  }

  const isRowHit = (el) => !el.matches("[data-slot=button]") && Boolean(el.closest("[data-row]")) && el.parentElement?.matches("[data-row],[data-row-hit],li");
  const notSized = "[role=checkbox],[role=switch],[role=radio],[role=option],[role=menuitem],[data-row-hit],[data-text-link]";
  for (const el of document.querySelectorAll("button,[role=button],a[data-slot=button],[role=tab]")) {
    if (!shown(el)) continue;
    if ((el.matches(notSized) && !el.matches("[data-slot=button]")) || isRowHit(el)) { census.exemptRows++; continue; }
    const r = el.getBoundingClientRect();
    const height = Math.round(r.height * 2) / 2;
    census.button[height] = (census.button[height] ?? 0) + 1;
    if (!(height in BUTTONS)) { flag("button", height + "px " + describe(el)); continue; }
    if (!el.matches("[data-slot=button]") || !clean(el.textContent)) continue;
    const pad = parseFloat(styleOf(el).paddingLeft);
    if (pad !== BUTTONS[height]) flag("button", height + "px with " + pad + "px padding " + describe(el));
  }

  // Text cut by something that isn't a scroller. An ellipsis is a stated truncation, counted, and only fails when it leaves almost nothing to read.
  for (const run of runs) {
    for (const rect of run.rects) {
      let cut = false, scrolledX = false, scrolledY = false, visible = rect;
      for (const node of [run.parent, ...ancestors(run.parent)]) {
        const s = styleOf(node);
        if (s.overflowX === "visible" && s.overflowY === "visible") continue;
        const box = node.getBoundingClientRect();
        const innerLeft = box.left + node.clientLeft, innerTop = box.top + node.clientTop;
        const overX = visible.right > innerLeft + node.clientWidth + 1 || visible.left < innerLeft - 1;
        const overY = rect.bottom > innerTop + node.clientHeight + 2 || rect.top < innerTop - 2;
        if (overX && !scrolledX && !isScroller(node, "x")) {
          if (s.textOverflow === "ellipsis") {
            if (!census.truncated.includes(run.text.slice(0, 40))) census.truncated.push(run.text.slice(0, 40));
            if (node.clientWidth < MIN_READABLE_TRUNCATION) flag("clipped", "truncated to " + node.clientWidth + "px " + describe(run.parent));
            // What the ellipsis hid can't be cut again further out, only the box that holds it can.
            visible = box;
          } else { flag("clipped", "cut by " + describe(node).slice(0, 40) + " at " + describe(run.parent)); cut = true; }
        }
        if (overY && !scrolledY && !isScroller(node, "y") && !(s.webkitLineClamp && s.webkitLineClamp !== "none")) { flag("clipped", "cut by " + describe(node).slice(0, 40) + " at " + describe(run.parent)); cut = true; }
        if (cut) break;
        if (overX && isScroller(node, "x")) scrolledX = true;
        if (overY && isScroller(node, "y")) scrolledY = true;
      }
      if (cut) break;
    }
  }

  const paintedRuns = [];
  for (const run of runs) {
    for (const rect of run.rects) {
      const box = visibleBox(rect, run.parent, true);
      if (box && box.width > 1 && box.height > 1) paintedRuns.push({ run, box });
    }
  }
  const iconButtons = [...document.querySelectorAll("button,a[data-slot=button]")].filter((el) => shown(el) && !clean(el.textContent));
  const paintedBoxes = paintedRuns.concat(iconButtons.flatMap((el) => { const box = visibleBox(el.getBoundingClientRect(), el); return box ? [{ run: { parent: el, text: describe(el) }, box }] : []; }));
  for (let i = 0; i < paintedBoxes.length; i++) {
    const a = paintedBoxes[i];
    for (let j = i + 1; j < paintedBoxes.length; j++) {
      const b = paintedBoxes[j];
      if (a.run === b.run || near(a.run.parent, b.run.parent)) continue;
      const width = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const height = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (width < 3 || height < OVERLAP_SHARE * Math.min(a.box.height, b.box.height)) continue;
      const x = (Math.min(a.box.right, b.box.right) + Math.max(a.box.left, b.box.left)) / 2;
      const y = (Math.min(a.box.bottom, b.box.bottom) + Math.max(a.box.top, b.box.top)) / 2;
      const stack = document.elementsFromPoint(x, y);
      const ia = stack.findIndex((el) => near(el, a.run.parent) && el.contains(a.run.parent));
      const ib = stack.findIndex((el) => near(el, b.run.parent) && el.contains(b.run.parent));
      if (ia < 0 || ib < 0) continue;
      const [upper, lower] = ia < ib ? [ia, ib] : [ib, ia];
      if (stack.slice(upper, lower).some((el) => paintsOver(el) && !el.contains(stack[lower]))) continue;
      if (behindScrim(a.run.parent) !== behindScrim(b.run.parent)) continue;
      flag("overlap", '"' + a.run.text.slice(0, 28) + '" over "' + b.run.text.slice(0, 28) + '"');
    }
  }

  // Text painted over by something that isn't a modal scrim or a sticky bar of its own scroller. Hit testing can't see text that takes no pointer events, such as a hover popup, so that text is skipped rather than reported as covered.
  for (const { run, box } of paintedRuns) {
    if (styleOf(run.parent).pointerEvents === "none") continue;
    const x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2;
    const top = document.elementFromPoint(x, y);
    if (!top || near(top, run.parent)) continue;
    if (isScrim(top) || (inModal(top) && !inModal(run.parent)) || behindScrim(run.parent)) continue;
    const own = scrollersOf(run.parent)[0];
    if (own && own.contains(top) && stickyBetween(top, own)) continue;
    if (!paintsOver(top) && !ancestors(top).slice(0, 4).some(paintsOver)) continue;
    flag("occluded", '"' + run.text.slice(0, 32) + '" under ' + describe(top).slice(0, 44));
  }

  // Every control has to be reachable: scrolled into view, its center must hit the control itself.
  const CONTROLS = "button,a[href],input:not([type=hidden]),textarea,select,[role=button],[role=tab],[role=checkbox],[role=switch],summary";
  const scrollers = [...document.querySelectorAll("*")].filter((el) => (isScroller(el, "y") && el.scrollHeight > el.clientHeight) || (isScroller(el, "x") && el.scrollWidth > el.clientWidth));
  const saved = scrollers.map((el) => [el, el.scrollTop, el.scrollLeft]);
  const restore = () => { for (const [el, top, left] of saved) { el.scrollTop = top; el.scrollLeft = left; } };
  const hits = (el) => {
    const rects = el.getClientRects();
    const r = rects.length > 1 ? rects[0] : el.getBoundingClientRect();
    const box = visibleBox(r, el);
    if (!box) return false;
    const top = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    return Boolean(top) && near(top, el);
  };
  const atRest = [...document.querySelectorAll(CONTROLS)].filter((el) => shown(el) && !el.disabled).map((el) => ({ el, rect: el.getBoundingClientRect(), box: visibleBox(el.getBoundingClientRect(), el) }));
  for (const { el, rect, box } of atRest) {
    if (box && el.matches("button[data-slot=button],a[data-slot=button]")) {
      const share = (box.width * box.height) / Math.max(rect.width * rect.height, 1);
      // A row at a scroller's edge is ordinary scrolling, and the reachable pass covers it. An action you need to move on can't sit half out of sight.
      const mustShow = el.closest("[data-action-bar]") || el.matches("[data-approve]") || el.matches(".bg-primary");
      if (mustShow && share > 0 && share < 0.75) flag("cut", Math.round(share * 100) + "% visible " + describe(el));
    }
    // A 1px sliver at a scroller's edge has its centre on the pixel boundary, so the hit lands on whatever sits next to the scroller.
    if (box && box.height >= 2) {
      const top = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      if (top && !near(top, el) && !isScrim(top) && !(inModal(top) && !inModal(el)) && !behindScrim(el)) {
        const own = scrollersOf(el)[0];
        const stickyOwn = own && own.contains(top) && stickyBetween(top, own);
        if (!stickyOwn) flag("hidden", describe(el) + " under " + describe(top).slice(0, 44));
      }
    }
  }
  for (const { el } of atRest) {
    if (behindScrim(el) || hits(el)) continue;
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    let reached = hits(el);
    if (!reached) { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); reached = hits(el); }
    if (!reached) {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (top && (isScrim(top) || (inModal(top) && !inModal(el)))) reached = true;
    }
    restore();
    if (!reached) flag("hidden", "unreachable " + describe(el));
  }
  restore();

  const containerOf = (el) => {
    for (const node of ancestors(el)) {
      const s = styleOf(node);
      if (isScroller(node, "x") || isScroller(node, "y") || parseFloat(s.borderLeftWidth) > 0 || parseFloat(s.borderRightWidth) > 0 || alphaOf(s.backgroundColor) > 0.02) return node;
    }
    return document.body;
  };
  const insets = (rect, container) => {
    const box = container.getBoundingClientRect();
    const left = rect.left + container.scrollLeft - box.left - container.clientLeft;
    const inner = isScroller(container, "x") ? container.scrollWidth : container.clientWidth;
    return { left, right: inner - left - rect.width };
  };
  const textBox = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5);
    if (!rects.length) return null;
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.min(Math.max(...rects.map((r) => r.right)), el.getBoundingClientRect().right);
    return { left, right, width: right - left };
  };
  const checkInset = (el, rect, label) => {
    if (!rect || rect.width <= 0) return;
    const { left, right } = insets(rect, containerOf(el));
    const least = Math.min(left, right);
    if (least < MIN_INSET - 0.5) flag("inset", Math.round(least) + "px " + label + " " + describe(el));
  };
  for (const cell of document.querySelectorAll("td,th")) if (shown(cell) && clean(cell.textContent)) checkInset(cell, textBox(cell), "cell");
  for (const badge of document.querySelectorAll('[data-slot="badge"]')) if (shown(badge)) checkInset(badge, badge.getBoundingClientRect(), "badge");
  for (const row of document.querySelectorAll("[data-row]")) {
    if (!shown(row)) continue;
    const box = row.getBoundingClientRect();
    if (box.height < 31.5) flag("rowHeight", Math.round(box.height) + "px " + describe(row));
    const content = [...row.querySelectorAll("*")].filter((el) => shown(el) && el.children.length === 0 && el.getBoundingClientRect().width > 0).map((el) => el.getBoundingClientRect());
    if (!content.length) continue;
    const left = Math.min(...content.map((r) => r.left)) - box.left;
    const right = box.right - Math.max(...content.map((r) => r.right));
    if (Math.min(left, right) < MIN_INSET - 0.5) flag("inset", Math.round(Math.min(left, right)) + "px row " + describe(row));
  }
  for (const tr of document.querySelectorAll("tr")) {
    if (!shown(tr) || tr.closest("thead") || !clean(tr.textContent)) continue;
    const h = tr.getBoundingClientRect().height;
    if (h < 35.5) flag("rowHeight", Math.round(h) + "px table row " + describe(tr));
  }

  // Overflow-y auto computes overflow-x auto, so a pane that only meant to scroll down still scrolls sideways when something spills out of it.
  for (const el of document.querySelectorAll("*")) {
    if (isScroller(el, "x") && el.scrollWidth > el.clientWidth + 1 && !el.hasAttribute("data-scroll-x") && shown(el)) flag("clipped", "spills " + (el.scrollWidth - el.clientWidth) + "px sideways out of " + describe(el).slice(0, 44));
  }

  // A labelled button has to clear the same padding as the rest of the window. An icon button carries its own inset inside its hit box.
  for (const el of document.querySelectorAll("button[data-slot=button],a[data-slot=button]")) {
    if (!shown(el) || !clean(el.textContent)) continue;
    const r = el.getBoundingClientRect();
    if (r.right < 0 || r.left > innerWidth) continue;
    const least = Math.min(r.left, innerWidth - r.right);
    if (least < MIN_WINDOW_EDGE - 0.5) flag("edge", Math.round(least) + "px from the window " + describe(el));
  }

  const banners = {};
  const modalOpen = document.querySelector("[role=dialog],[role=alertdialog]");
  for (const el of document.querySelectorAll('[data-banner],[role="alert"],[role="status"],[data-approval-reset],[data-card-reason],[data-testid="sent-banner"]')) {
    if (!shown(el) || el.parentElement?.closest("[data-banner]") || (modalOpen && !inModal(el))) continue;
    const text = clean(el.textContent);
    const named = (el.getAttribute("data-banner") ?? "") + " " + text;
    const problem = el.getAttribute("data-problem") ?? PROBLEMS.find(([, pattern]) => pattern.test(named))?.[0] ?? text.slice(0, 32);
    (banners[problem] ??= []).push(describe(el));
  }
  for (const [problem, list] of Object.entries(banners)) if (list.length > 1) flag("banner", problem + ": " + list.length + " banners");

  census.measure = {};
  for (const [name, selector] of Object.entries(${JSON.stringify(MEASURED)})) {
    const el = [...document.querySelectorAll(selector)].find(shown);
    if (!el) continue;
    const c = styleOf(el), r = el.getBoundingClientRect();
    census.measure[name] = "h" + Math.round(r.height * 10) / 10 + " w" + Math.round(r.width) + " pad " + [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].map(parseFloat).join("/") + " type " + parseFloat(c.fontSize) + "/" + parseFloat(c.lineHeight) + " color " + c.color;
  }
  return { found, census };
})()`;

// One known defect per category, plus a clean block, so a passing audit can't be a broken audit.
const SEEDS = String.raw`
<style>body{margin:0;background:#111;color:#eee;font:13px/20px sans-serif}[data-slot=button]{display:inline-block;box-sizing:border-box;border:0}.panel{position:absolute;left:0;width:600px;background:#222}</style>
<div class="panel" style="top:0;height:60px;padding:16px">
  <span id="seed-clean" style="font-size:12px">Clean text</span>
  <button data-slot="button" style="height:32px;padding:0 12px;font:13px sans-serif">Clean button</button>
</div>
<div class="panel" style="top:80px;height:40px;padding:16px"><span style="font-size:11px">seed-font-small</span></div>
<div class="panel" style="top:140px;height:40px;padding:16px"><button data-slot="button" style="height:22px;padding:0 8px;font:13px sans-serif">seed-button-short</button></div>
<div class="panel" style="top:200px;height:40px;padding:16px"><button data-slot="button" style="height:32px;padding:0 5px;font:13px sans-serif">seed-button-padding</button></div>
<div class="panel" style="top:260px;height:40px;padding:16px"><div style="width:60px;overflow:hidden;white-space:nowrap">seed-clipped-long-text-with-no-ellipsis</div></div>
<div class="panel" style="top:320px;height:40px;padding:16px"><span style="position:absolute">seed-overlap-first</span><span style="position:absolute">seed-overlap-other</span></div>
<div class="panel" style="top:380px;height:40px;padding:16px;overflow:visible">
  <span>seed-occluded-text-behind-an-opaque-panel</span>
  <div id="seed-opaque" style="position:absolute;left:0;top:0;width:600px;height:72px;background:#333;z-index:2"></div>
</div>
<div class="panel" style="top:470px;height:60px;padding:16px">
  <button data-slot="button" style="height:32px;padding:0 12px;font:13px sans-serif">seed-hidden-control</button>
  <div style="position:absolute;left:0;top:0;width:600px;height:92px;background:#333;z-index:2"></div>
</div>
<div data-testid="chat" class="panel" style="top:570px;height:40px;overflow-y:auto;padding:0 16px"><div style="height:30px"></div><button data-slot="button" data-approve style="height:32px;padding:0 12px;font:13px sans-serif">seed-cut-control</button></div>
<div class="panel" style="top:630px;height:40px;border:1px solid #444;padding:8px 4px"><span data-slot="badge">seed-inset-badge</span></div>
<ul class="panel" style="top:700px;margin:0;padding:0;list-style:none"><li data-row="x" style="height:24px;padding:0 12px">seed-row-short</li></ul>
<div class="panel" style="top:740px;height:30px;padding:0 16px">
  <div data-banner="one" data-problem="seed-problem">first banner</div>
  <div data-banner="two" data-problem="seed-problem">second banner</div>
  <p role="alert">Your token expired</p>
  <div data-banner="three">Reconnect to keep going</div>
</div>`;

const SEED_STYLE = String.raw`<style>body{margin:0;background:#111;color:#eee;font:13px/20px sans-serif}[data-slot=button]{display:inline-block;box-sizing:border-box;border:0}.panel{position:absolute;left:0;width:600px;background:#222}</style>`;

// The escapes: an exemption can't be claimed by a button, spill can't hide in a scroller, and a dialog's own contents still count.
const ESCAPE_SEEDS = String.raw`${SEED_STYLE}
<div class="panel" style="top:0;height:30px;padding:0 16px"><div data-banner="failed">seed one</div><p role="alert">Ran out of tries on it</p></div>
<div class="panel" style="top:100px;height:40px;padding:4px 16px"><button data-slot="button" data-text-link style="height:22px;padding:0 8px;font:13px sans-serif">seed-exempt-button</button></div>
<div class="panel" style="top:160px;height:30px;overflow-y:auto;padding:0 16px"><div style="width:900px;height:20px">seed-sideways</div></div>
<div class="panel" style="top:220px;height:40px;padding:0"><button data-slot="button" style="height:32px;padding:0 12px;font:13px sans-serif">seed-edge-button</button></div>`;

const DIALOG_SEED = String.raw`${SEED_STYLE}
<div role="dialog" class="panel" style="top:0;height:60px;padding:16px"><span>seed-covered-in-a-dialog</span><div style="position:absolute;left:0;top:0;width:600px;height:92px;background:#333;z-index:2"></div></div>`;

export const CLEAN_SEED = String.raw`
<style>body{margin:0;background:#111;color:#eee;font:13px/20px sans-serif}[data-slot=button]{display:inline-block;box-sizing:border-box;border:0}</style>
<div style="padding:16px;background:#222;width:600px">
  <span>Clean text</span>
  <span data-slot="badge">Badge</span>
  <button data-slot="button" style="height:32px;padding:0 12px;font:13px sans-serif">Clean button</button>
  <table style="width:100%;background:#222"><tr style="height:36px"><td style="padding:10px 12px">Cell</td></tr></table>
  <div data-banner="one" data-problem="only">One banner</div>
</div>
<div role="dialog" style="padding:16px;background:#222;width:300px"><p role="alert">Your token expired</p></div>
<div data-banner="behind" style="padding:16px;width:300px">Token expired behind the open dialog</div>`;

const SEED_EXPECTATIONS = [
  ["font", "seed-font-small"],
  ["button", "seed-button-short"],
  ["button", "seed-button-padding"],
  ["clipped", "seed-clipped"],
  ["overlap", "seed-overlap"],
  ["occluded", "seed-occluded"],
  ["hidden", "seed-hidden-control"],
  ["cut", "seed-cut-control"],
  ["inset", "seed-inset-badge"],
  ["rowHeight", "seed-row-short"],
  ["banner", "seed-problem"],
  ["banner", "token: 2"],
];

export const SEED_PAGES = [
  [SEEDS, SEED_EXPECTATIONS],
  [
    ESCAPE_SEEDS,
    [
      ["banner", "failed: 2"],
      ["button", "seed-exempt-button"],
      ["clipped", "seed-sideways"],
      ["edge", "seed-edge-button"],
    ],
  ],
  [DIALOG_SEED, [["occluded", "seed-covered-in-a-dialog"]]],
];

// Plan section 6 lists these, and the frozen set has no 1180 version of them. The rest of section 6 already has its own 1180 shot.
// Keyed by verify module and named without the shot number, because new shots renumber the ones after them.
export const TWIN_IMAGES = {
  grading: ["queue-expanded", "send-preview", "banner-reconnect"],
  courses: [
    "due",
    "inbox-school-filter",
    "inbox-review",
    "gradebook-sticky-scrolled",
    "gradebook-pending",
  ],
  settings: ["settings-connections"],
  term: [
    "term-dates-pattern-change-and-break",
    "term-copy-approve",
    "term-scan-findings",
    "term-review-plain-preview",
    "term-publish-check-not-ready",
  ],
};

export const unnumbered = (base) => base.replace(/(^|-)\d+-/, "$1");
