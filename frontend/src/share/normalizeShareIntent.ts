/**
 * Turn an OS share payload (from expo-share-intent) into a MemoPad note draft.
 *
 * Pure + portable: the one side effect (reading a small image to base64) is INJECTED via
 * `ShareDeps`, so this maps cleanly and unit-tests in Node without React Native. Files that
 * aren't inlined are emitted as `pendingFiles` descriptors — the editor uploads those with
 * progress (so the user sees a filename + radial progress instead of a blank wait).
 *
 * Mapping (see the spec table):
 *   - URL (browser / Docs "copy link")      → title = page title || url, body = url, tag "link"
 *   - plain text (WhatsApp forward, etc.)    → body = text, no title (needsTitle)
 *   - image file ≤ caps                      → inline base64 in images[]
 *   - large image / doc / audio / video / …  → pendingFiles[] (editor uploads with progress)
 *   - multiple files                         → ONE draft
 */

export interface NoteDraftTag {
  name: string;
  color: string;
}

/** A file to be uploaded by the editor (with progress) rather than inlined. */
export interface PendingFile {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface NoteDraft {
  title: string;
  content: string;
  tags: NoteDraftTag[];
  images: string[]; // base64 data URIs (inline images)
  pendingFiles: PendingFile[]; // uploaded by the editor → become attachments
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
  /** Surface a non-fatal warning (e.g. unknown type attached as a generic file). */
  onWarn?: (message: string) => void;
}

/** Inline base64 only below this size PER image; larger images upload as files. */
export const IMAGE_INLINE_CAP = 5 * 1024 * 1024; // 5 MB
/** Cumulative inline budget across a share (base64 inflates ~4/3; the backend caps a
 * note's total images at 8 MB). Images past the budget upload as files instead. */
export const IMAGE_INLINE_TOTAL_BUDGET = 5 * 1024 * 1024; // 5 MB raw ⇒ ~6.7 MB base64
const LINK_TAG: NoteDraftTag = { name: 'link', color: '#4F8EF7' };
const URL_RE = /^https?:\/\/\S+$/i;

function baseName(name: string | null | undefined, fallback: string): string {
  // Sanitize filenames from an untrusted source: collapse path separators, strip
  // control characters (0x00–0x1f, 0x7f).
  const n = (name || '')
    .trim()
    .replace(/[/\\]+/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '');
  return n || fallback;
}

function stripExt(name: string): string {
  return name.replace(/\.[^./\\]+$/, '');
}

export async function normalizeShareIntent(intent: RawShareIntent, deps: ShareDeps): Promise<NoteDraft> {
  const draft: NoteDraft = { title: '', content: '', tags: [], images: [], pendingFiles: [], needsTitle: false };

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
  let inlineBytes = 0; // cumulative raw bytes inlined so far (budget guard)
  for (const f of files) {
    const mime = (f.mimeType || '').toLowerCase();
    const size = f.size ?? 0;
    const isImage = mime.startsWith('image/');
    const name = baseName(f.fileName, 'shared-file');
    const canInline = isImage && size > 0 && size <= IMAGE_INLINE_CAP && inlineBytes + size <= IMAGE_INLINE_TOTAL_BUDGET;

    if (canInline) {
      try {
        const b64 = await deps.readBase64(f.path);
        draft.images.push(`data:${mime};base64,${b64}`);
        inlineBytes += size;
      } catch {
        // Couldn't read for inline — fall back to uploading it as a file.
        draft.pendingFiles.push({ uri: f.path, name, mimeType: mime || 'application/octet-stream', size });
      }
    } else {
      // Large image, doc, audio, video, or unknown type → uploaded by the editor.
      if (!mime) deps.onWarn?.('Unrecognized file type — attaching as a file.');
      draft.pendingFiles.push({ uri: f.path, name, mimeType: mime || 'application/octet-stream', size });
    }
  }

  // Title fallback from the shared file(s) when we don't already have one.
  if (!draft.title && files.length > 0) {
    const allImages = files.every((f) => (f.mimeType || '').toLowerCase().startsWith('image/'));
    draft.title = allImages ? 'Photo note' : stripExt(baseName(files[0].fileName, 'Shared file'));
    draft.needsTitle = false;
  }

  // Nothing usable arrived — let the UI prompt for a title.
  if (!draft.title && !draft.content && draft.images.length === 0 && draft.pendingFiles.length === 0) {
    draft.needsTitle = true;
  }

  return draft;
}
