/**
 * Turn an OS share payload (from expo-share-intent) into a MemoPad note draft.
 *
 * Pure + portable: side effects (reading a file to base64, uploading a blob) are
 * INJECTED via `ShareDeps`, so this maps cleanly and unit-tests in Node without React
 * Native — the same dependency-injection pattern as the crypto core. The app wires in
 * `expo-file-system` + `uploadAttachment`; tests wire in stubs.
 *
 * Mapping (see the spec table):
 *   - URL (browser / Docs "copy link")      → title = page title || url, body = url, tag "link"
 *   - plain text (WhatsApp forward, etc.)    → body = text, no title (needsTitle)
 *   - image file ≤ cap                       → inline base64 in images[]
 *   - large image / doc / video / unknown    → uploadAttachment → attachments[]
 *   - multiple files                         → ONE draft with multiple images/attachments
 */

export interface NoteDraftTag {
  name: string;
  color: string;
}

export interface NoteDraft {
  title: string;
  content: string;
  tags: NoteDraftTag[];
  images: string[]; // base64 data URIs (inline images)
  attachments: any[]; // Attachment[] (blob-storage metadata)
  needsTitle: boolean; // true ⇒ UI should nudge the user to add a title
}

/** One shared file, structurally typed to match expo-share-intent's `ShareIntentFile`. */
export interface ShareFile {
  path: string; // file:// uri
  mimeType?: string | null;
  fileName?: string | null;
  size?: number | null;
}

/** Structural subset of expo-share-intent's `ShareIntent` that we consume. */
export interface RawShareIntent {
  text?: string | null;
  webUrl?: string | null;
  files?: ShareFile[] | null;
  meta?: { title?: string | null } | null;
}

export interface ShareDeps {
  /** Read a file uri → raw base64 (no `data:` prefix). */
  readBase64: (uri: string) => Promise<string>;
  /** Upload a file to blob storage → Attachment metadata. */
  uploadFile: (f: { name: string; mimeType: string; uri: string; size: number }) => Promise<any>;
  /** Surface a non-fatal warning (e.g. unknown type attached as a generic file). */
  onWarn?: (message: string) => void;
}

/** Inline base64 only below this size; larger images go to blob storage instead so a
 * big payload never lands in a note / the sync queue. */
export const IMAGE_INLINE_CAP = 5 * 1024 * 1024; // 5 MB
const LINK_TAG: NoteDraftTag = { name: 'link', color: '#4F8EF7' };
const URL_RE = /^https?:\/\/\S+$/i;

function baseName(name: string | null | undefined, fallback: string): string {
  const n = (name || '').trim();
  return n || fallback;
}

function stripExt(name: string): string {
  return name.replace(/\.[^./\\]+$/, '');
}

export async function normalizeShareIntent(intent: RawShareIntent, deps: ShareDeps): Promise<NoteDraft> {
  const draft: NoteDraft = { title: '', content: '', tags: [], images: [], attachments: [], needsTitle: false };

  const text = intent.text?.trim() || '';
  // Treat a bare URL that arrived as plain text as a web URL too (some apps don't set webUrl).
  const url = intent.webUrl?.trim() || (URL_RE.test(text) ? text : '');

  if (url) {
    draft.title = (intent.meta?.title || '').trim() || url;
    draft.content = url;
    draft.tags = [LINK_TAG];
  } else if (text) {
    draft.content = text;
    draft.needsTitle = true; // body-only note — prompt for a title
  }

  const files = intent.files ?? [];
  for (const f of files) {
    const mime = (f.mimeType || '').toLowerCase();
    const size = f.size ?? 0;
    const isImage = mime.startsWith('image/');

    if (isImage && size > 0 && size <= IMAGE_INLINE_CAP) {
      const b64 = await deps.readBase64(f.path);
      draft.images.push(`data:${mime};base64,${b64}`);
    } else {
      if (!mime) deps.onWarn?.('Unrecognized file type — attached as a file.');
      const att = await deps.uploadFile({
        name: baseName(f.fileName, 'shared-file'),
        mimeType: mime || 'application/octet-stream',
        uri: f.path,
        size,
      });
      draft.attachments.push(att);
    }
  }

  // Title fallback from the shared file(s) when we don't already have one.
  if (!draft.title && files.length > 0) {
    const allImages = files.every((f) => (f.mimeType || '').toLowerCase().startsWith('image/'));
    draft.title = allImages ? 'Photo note' : stripExt(baseName(files[0].fileName, 'Shared file'));
    draft.needsTitle = false;
  }

  // Nothing usable arrived — let the UI prompt for a title.
  if (!draft.title && !draft.content && draft.images.length === 0 && draft.attachments.length === 0) {
    draft.needsTitle = true;
  }

  return draft;
}
