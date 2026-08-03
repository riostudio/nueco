/**
 * syncMergeCore.ts
 *
 * The reconciliation rule for "server said X, this device has Y", extracted from offlineSync's
 * fullSync so it can be unit-tested without a filesystem, a network, or a React Native runtime
 * (same pattern as calendarSyncCore / noteObjectsCore).
 *
 * The rule that matters most here is what a record's ABSENCE from a server response means.
 * fullSync used to treat absence as authoritative: anything the server didn't return was dropped
 * from the local store. That is only sound if the response covered the entire collection, and it
 * never did - the list endpoints are paginated and the client only ever read page one, so every
 * note past the first 50 was deleted from the device on each sync. Absence is now only treated as
 * a server-side delete when the pull is known to have reached the end of the collection.
 */

/** The subset of a note/event/trip that reconciliation actually reads. */
export interface MergeableRecord {
  id: string;
  created_at: string;
  updated_at?: string | null;
  /** True while the record has never reached the server (so the server cannot know about it). */
  _isLocal?: boolean;
  /** True once a delete is queued for it; the UI already hides these. */
  _pendingDelete?: boolean;
}

/**
 * The timestamp reconciliation compares. Falls back to `created_at` for records written before
 * their type carried `updated_at` (legacy local events, and events stored server-side before the
 * field existed - the backend backfills the same way on read).
 */
export function recordTimestamp(record: MergeableRecord): string {
  return record.updated_at || record.created_at || '';
}

/**
 * Strict "a is newer than b" over ISO timestamps. Unparseable inputs lose rather than throw: an
 * unreadable timestamp on one side should not let it win a comparison it cannot actually make.
 */
export function isNewerTimestamp(a: string, b: string): boolean {
  const timeA = Date.parse(a);
  const timeB = Date.parse(b);
  if (Number.isNaN(timeA)) return false;
  if (Number.isNaN(timeB)) return true;
  return timeA > timeB;
}

export interface MergeInput<T extends MergeableRecord> {
  /** Records from the server pull, already decrypted. */
  server: readonly T[];
  /** What this device currently has stored. */
  local: readonly T[];
  /** Whether the pull actually read every page of the collection (see PagedPull.complete). */
  serverPullComplete: boolean;
  /** ISO timestamp captured immediately before the pull began. */
  pullStartedAt: string;
  /**
   * Copy device-only fields from the previous local copy onto an incoming server record. The
   * server never stores them, so without this they are wiped on every pull (events use it for
   * `local_notification_id`, the OS notification handle - losing it orphans a scheduled reminder
   * that nothing can then cancel).
   */
  adoptLocalFields?: (serverRecord: T, previousLocal: T | undefined) => T;
}

/**
 * Reconcile a server pull against the local store, newest-write-wins.
 *
 * Precedence, in order:
 *  1. A local record queued for deletion never comes back as a live record.
 *  2. A local-only record always survives; the server has never heard of it.
 *  3. When both sides have it, the newer `updated_at` wins.
 *  4. When only the local side has it, it survives unless the pull is trustworthy enough for
 *     absence to mean deletion (see `absenceMeansDeleted`).
 */
export function mergeRecords<T extends MergeableRecord>(input: MergeInput<T>): T[] {
  const { server, local, serverPullComplete, pullStartedAt, adoptLocalFields } = input;

  const localById = new Map<string, T>(local.map((record) => [record.id, record]));
  const merged = new Map<string, T>();

  for (const serverRecord of server) {
    const previousLocal = localById.get(serverRecord.id);
    const withLocalFields = adoptLocalFields
      ? adoptLocalFields(serverRecord, previousLocal)
      : serverRecord;
    merged.set(serverRecord.id, { ...withLocalFields, _isLocal: false });
  }

  for (const localRecord of local) {
    if (localRecord._pendingDelete) {
      // The record is hidden locally and its delete is queued. Until that delete lands, the server
      // still returns it, and taking the server's copy would put it back in the list the user just
      // deleted it from - so the tombstone overwrites it instead. Once the server stops returning
      // it the tombstone is no longer re-added here, which is what finally clears it from the store.
      if (merged.has(localRecord.id)) merged.set(localRecord.id, localRecord);
      continue;
    }

    if (localRecord._isLocal) {
      merged.set(localRecord.id, localRecord);
      continue;
    }

    const serverRecord = merged.get(localRecord.id);
    if (serverRecord) {
      // A local edit newer than the server's copy hasn't landed there yet - the push is still in
      // flight, or it is racing this very pull. Keep it, or the pull silently reverts the edit.
      if (isNewerTimestamp(recordTimestamp(localRecord), recordTimestamp(serverRecord))) {
        merged.set(localRecord.id, localRecord);
      }
      continue;
    }

    if (!absenceMeansDeleted(localRecord, serverPullComplete, pullStartedAt)) {
      merged.set(localRecord.id, localRecord);
    }
  }

  return Array.from(merged.values());
}

/**
 * Whether a synced record missing from the server response should be deleted locally.
 *
 * Requires both:
 *  - the pull reached the end of the collection, so the record was genuinely looked for; and
 *  - the record was not written after the pull started. A local edit mid-pull re-sorts the record
 *    to the front of the server's ordering (notes page by `updated_at` descending), where a page
 *    already read can no longer return it - so its absence says nothing about whether it exists.
 */
export function absenceMeansDeleted(
  localRecord: MergeableRecord,
  serverPullComplete: boolean,
  pullStartedAt: string,
): boolean {
  if (!serverPullComplete) return false;
  return !isNewerTimestamp(recordTimestamp(localRecord), pullStartedAt);
}
