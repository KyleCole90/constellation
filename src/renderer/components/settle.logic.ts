import type { ThreadId } from "~/shared/domain/ids";

/** One Undo covers every settle made while its toast is up, so a second settle adds to it instead of replacing it. */
export const pendingAfterSettle = (
  pending: readonly ThreadId[],
  settled: readonly ThreadId[],
): readonly ThreadId[] => [...new Set([...pending, ...settled])];

export const pendingAfterResume = (
  pending: readonly ThreadId[],
  resumed: readonly ThreadId[],
): readonly ThreadId[] => pending.filter((id) => !resumed.includes(id));

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const TOAST_GAP = 8;

/** The toast's distance from the viewport bottom that clears the composer, or null when they do not meet. */
export const toastBottomOver = (
  toast: Box,
  composer: Box | null,
  viewportHeight: number,
): number | null => {
  if (!composer) return null;
  const meet =
    toast.left < composer.right &&
    composer.left < toast.right &&
    toast.top < composer.bottom &&
    composer.top < toast.bottom;
  return meet ? viewportHeight - composer.top + TOAST_GAP : null;
};
