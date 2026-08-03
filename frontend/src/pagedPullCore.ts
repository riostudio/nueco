/**
 * pagedPullCore.ts
 *
 * Assembling a whole collection out of paged responses, with no knowledge of fetch, auth or
 * routes, so the paging arithmetic can be tested directly (same pattern as calendarSyncCore).
 *
 * api.ts supplies the request; everything that decides "is there another page" lives here.
 */

/**
 * A whole-collection pull assembled from paged responses.
 *
 * `complete` is the load-bearing half. The list endpoints have always been paginated
 * (`GET /notes` has defaulted to 50 per page since it was written), but the client asked for
 * `/notes` with no page params and treated the one page it got back as the entire collection.
 * `fullSync` then rebuilt the local store from it, so every note past the first page was dropped
 * from the device on every sync - silently, since from the client's point of view the server had
 * simply stopped returning them. Knowing whether a pull actually reached the end of the collection
 * is what lets the merge tell "the server deleted this" apart from "this pull never saw it".
 */
export interface PagedPull<T> {
  items: T[];
  complete: boolean;
}

/** Fetches one page, 1-indexed to match the backend's `page` query parameter. */
export type PageFetcher<T> = (page: number, pageSize: number) => Promise<T[]>;

/**
 * Hard ceiling on requests per pull so a server that keeps returning full pages can't spin here
 * forever. Reaching it marks the pull incomplete rather than pretending it finished.
 */
export const MAX_PAGES_PER_PULL = 100;

/**
 * Read pages until one comes back short, then report what was gathered and whether the end of the
 * collection was actually reached.
 *
 * Failure is deliberately asymmetric. A first-page failure means the pull produced nothing, and a
 * caller that merged that would read an empty collection as "the server has nothing" - so it
 * throws and the caller skips the merge. A later-page failure has real records behind it, so those
 * are kept and the pull is marked incomplete, which the merge already treats as "absence proves
 * nothing".
 */
export async function collectPages<T>(
  fetchPage: PageFetcher<T>,
  pageSize: number,
): Promise<PagedPull<T>> {
  const items: T[] = [];

  for (let page = 1; page <= MAX_PAGES_PER_PULL; page++) {
    let batch: T[];
    try {
      batch = await fetchPage(page, pageSize);
    } catch (e) {
      if (page === 1) throw e;
      return { items, complete: false };
    }
    if (!Array.isArray(batch)) {
      throw new Error(`Expected an array of records for page ${page}, received ${typeof batch}`);
    }
    items.push(...batch);
    // A short page is the end of the collection. A page that comes back exactly full might also be
    // the end, but there is no way to know without asking - so ask.
    if (batch.length < pageSize) return { items, complete: true };
  }

  return { items, complete: false };
}
