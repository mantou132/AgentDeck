import type { Attachment } from '../session/types';

export const LONG_PASTE_CHAR_THRESHOLD = 2_000;

export const createPasteReference = (attachment: Attachment, number: number): Attachment => {
  const label = attachment.kind === 'image' ? `Image #${number}` : `Pasted text #${number}`;
  return {
    ...attachment,
    pasteReference: number,
    marker: `[${label}]`,
    name: attachment.kind === 'image' ? label : `${label}.txt`,
  };
};

export const syncPasteReferences = (input: string, attachments: Attachment[], references: Iterable<Attachment>) => [
  ...attachments.filter((attachment) => !attachment.marker),
  ...Array.from(references)
    .filter((attachment): attachment is Attachment & { marker: string } =>
      Boolean(attachment.marker && input.includes(attachment.marker)),
    )
    .sort((a, b) => input.indexOf(a.marker) - input.indexOf(b.marker)),
];

// References act as one editable unit, including when the same reference is copied.
export const expandReferenceRange = (
  input: string,
  attachments: Attachment[],
  start: number,
  end: number,
  includeCaretInside = false,
) => {
  let from = start;
  let to = end;
  for (const { marker } of attachments) {
    if (!marker) continue;
    for (
      let position = input.indexOf(marker);
      position >= 0;
      position = input.indexOf(marker, position + marker.length)
    ) {
      const markerEnd = position + marker.length;
      const overlaps =
        start === end
          ? includeCaretInside && position < start && start < markerEnd
          : position < end && markerEnd > start;
      if (overlaps) {
        from = Math.min(from, position);
        to = Math.max(to, markerEnd);
      }
    }
  }
  return { start: from, end: to };
};
