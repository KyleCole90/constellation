const CONTROL = "a[href], button, input, select, textarea, [tabindex]";

interface Point {
  x: number;
  y: number;
}

const shown = (el: Element): el is HTMLElement =>
  el instanceof HTMLElement &&
  !el.matches(":disabled") &&
  !el.closest("[inert]") &&
  el.getClientRects().length > 0;

const reachable = (el: Element): el is HTMLElement =>
  shown(el) && !el.matches('[tabindex="-1"], input[type="hidden"]');

const centre = (el: Element): Point => {
  const box = el.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
};

const distance = (el: Element, to: Point) => {
  const at = centre(el);
  return Math.hypot(at.x - to.x, at.y - to.y);
};

const nearest = (els: readonly HTMLElement[], to: Point) =>
  els.reduce<HTMLElement | null>(
    (best, el) => (!best || distance(el, to) < distance(best, to) ? el : best),
    null,
  );

/**
 * The control nearest to where the lost one sat, inside the closest ancestor still on the page. That is usually the
 * control that took its place, such as Connect after Disconnect. When that ancestor has none, the first control after
 * it, where the next Tab would have gone.
 */
const nearestSurvivor = (ancestors: readonly Element[], was: Point): HTMLElement | null => {
  const survivors = ancestors.filter((ancestor) => ancestor.isConnected);
  const controls = (ancestor: Element) =>
    [...ancestor.querySelectorAll(CONTROL)].filter((el): el is HTMLElement => reachable(el));
  const [closest] = survivors;
  if (!closest) return null;
  const near = nearest(controls(closest), was);
  if (near) return near;
  for (const [i, ancestor] of survivors.entries()) {
    const inner = survivors[i - 1];
    const next =
      inner &&
      controls(ancestor).find(
        (el) =>
          !inner.contains(el) &&
          Boolean(inner.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
    if (next) return next;
  }
  return null;
};

/** Nothing the person chose holds focus: it sits on the body, or on a screen's heading where arrival parked it. */
export const focusIsFree = (doc: Document = document) =>
  !doc.activeElement || doc.activeElement === doc.body || doc.activeElement.matches("h1");

/**
 * When an action takes the focused control off the page, the browser drops focus to the body and the next Tab starts
 * from the top. An action names where focus goes next in `data-lands`, a selector whose nearest match takes it, such as
 * Approve after Undo approval. One Enter too many then repeats nothing that can't be taken back. An action that names
 * nothing, such as Disconnect, hands focus to the nearest survivor. A dialog's own controls don't count, so closing a
 * dialog whose opener is gone lands next to where the opener was. On another screen, focus goes to its heading unless
 * the screen took focus itself.
 */
export function keepFocusOnThePage(doc: Document) {
  let ancestors: Element[] = [];
  let lands: string | null = null;
  let was: Point = { x: 0, y: 0 };
  let screen = "";
  let heading = "";
  const lost = () => !doc.activeElement || doc.activeElement === doc.body;

  doc.addEventListener("focusin", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('[role="dialog"]')) return;
    ancestors = [];
    for (let el: Element | null = target; el; el = el.parentElement) ancestors.push(el);
    lands = target.getAttribute("data-lands");
    was = centre(target);
    screen = doc.location.pathname;
    heading = doc.querySelector("h1")?.textContent ?? "";
  });
  // Clicking somewhere blank puts focus on the body on purpose. Forget the control, so a later re-render can't pull focus back.
  doc.addEventListener("focusout", (event) => {
    const target = event.target;
    if (target !== ancestors[0] || !(target instanceof Element)) return;
    queueMicrotask(() => {
      if (lost() && target.isConnected && !target.matches(":disabled")) ancestors = [];
    });
  });
  new MutationObserver(() => {
    if (!lost()) return;
    if (screen && doc.location.pathname !== screen) {
      // The address changes before the new screen renders, so the old screen's heading can still be on the page.
      const title = doc.querySelector("h1");
      if (!title || title.textContent === heading) return;
      ancestors = [];
      title.tabIndex = -1;
      return title.focus();
    }
    if (!ancestors[0] || ancestors[0].isConnected) return;
    const landing = lands && nearest([...doc.querySelectorAll(lands)].filter(shown), was);
    const next = landing || nearestSurvivor(ancestors, was);
    ancestors = [];
    next?.focus();
  }).observe(doc.body, { childList: true, subtree: true });
}
