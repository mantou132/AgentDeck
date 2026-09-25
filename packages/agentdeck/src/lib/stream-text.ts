const graphemeSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

const graphemeEndOffsets = (text: string) => {
  if (!graphemeSegmenter) {
    let offset = 0;
    return Array.from(text, (value) => (offset += value.length));
  }
  return Array.from(graphemeSegmenter.segment(text), ({ index, segment }) => index + segment.length);
};

export const STREAM_REVEAL_INTERVAL = 32;

/** Reveal an append-only target in short, overlapping animation steps without
 * splitting emoji or other grapheme clusters. A large backlog catches up
 * faster, but normal streaming stays close to character granularity. */
export function nextStreamingText(displayText: string, targetText: string): string {
  if (!targetText.startsWith(displayText)) return targetText;

  const pending = targetText.slice(displayText.length);
  if (!pending) return displayText;

  const offsets = graphemeEndOffsets(pending);
  const revealCount = Math.min(
    offsets.length,
    offsets.length > 120 ? 12 : offsets.length > 48 ? 8 : offsets.length > 16 ? 4 : 3,
  );
  let endOffset = offsets[revealCount - 1];

  // Finish a nearby short English word instead of cutting it in half.
  const nearbyBoundary = pending
    .slice(endOffset)
    .match(
      /^[^\s.,!?;:\u3001\u3002\uff01\uff0c\uff1a\uff1b\uff1f]{0,4}[\s.,!?;:\u3001\u3002\uff01\uff0c\uff1a\uff1b\uff1f]/u,
    )?.[0];
  if (nearbyBoundary) endOffset += nearbyBoundary.length;

  return displayText + pending.slice(0, endOffset);
}

const activeStreams = new Set<string>();

export function registerActiveStream(key: string) {
  if (!key) return;
  activeStreams.add(key);
}

export function unregisterActiveStream(key: string) {
  if (!key) return;
  activeStreams.delete(key);
}

export function hasActiveStream(prefix?: string): boolean {
  if (!prefix) return activeStreams.size > 0;
  for (const key of activeStreams) {
    if (key === prefix || key.startsWith(`${prefix}:`)) return true;
  }
  return false;
}

export function clearActiveStreams() {
  activeStreams.clear();
}
