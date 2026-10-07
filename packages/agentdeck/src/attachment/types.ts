export type Attachment = {
  id: string;
  name: string;
  /** Set when pasted into the composer, which shows `marker` in the input. */
  pasteReference?: number;
  marker?: string;
} & (
  | { kind: 'image'; data: string; mimeType: string; previewUrl: string }
  | { kind: 'text'; text: string }
  /** Uploaded as `data` and saved on the host by the daemon; history refers to the saved file by `uri`. */
  | ({ kind: 'file' } & ({ data: string; mimeType: string } | { uri: string }))
);
