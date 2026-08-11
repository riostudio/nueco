/**
 * Unit tests for the paged collection pull. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/pagedPullCore.test.ts
 *
 * `complete` is what the callers act on, so most of these assert when a pull is entitled to claim
 * it read the whole collection - claiming it wrongly is what makes fullSync delete real records.
 */
import { collectPages, MAX_PAGES_PER_PULL } from './pagedPullCore';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

/** A server holding `total` records, handing them out `pageSize` at a time. */
function fakeServer(total: number) {
  const requests: Array<{ page: number; pageSize: number }> = [];
  const fetchPage = async (page: number, pageSize: number) => {
    requests.push({ page, pageSize });
    const start = (page - 1) * pageSize;
    return Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) },
      (_, i) => ({ id: `r${start + i}` }));
  };
  return { fetchPage, requests };
}

async function main() {
  console.log('collectPages - reaching the end of a collection:');
  {
    const { fetchPage, requests } = fakeServer(3);
    const pull = await collectPages(fetchPage, 50);
    ok('a short first page is the whole collection', pull.items.length === 3 && pull.complete === true,
      JSON.stringify(pull));
    ok('and costs a single request', requests.length === 1, JSON.stringify(requests));
  }
  {
    const { fetchPage, requests } = fakeServer(0);
    const pull = await collectPages(fetchPage, 50);
    ok('an empty collection is complete, not a failure',
      pull.items.length === 0 && pull.complete === true, JSON.stringify(pull));
    ok('and still only asks once', requests.length === 1);
  }
  {
    // 120 records at 50/page: 50, 50, 20. The bug this whole change fixes was stopping after the
    // first of those three and treating the other 70 as deleted.
    const { fetchPage, requests } = fakeServer(120);
    const pull = await collectPages(fetchPage, 50);
    ok('every page is read, not just the first', pull.items.length === 120, String(pull.items.length));
    ok('the pull is marked complete', pull.complete === true);
    ok('pages are requested in order, 1-indexed',
      requests.map((r) => r.page).join(',') === '1,2,3', JSON.stringify(requests));
    ok('records keep their server order across the page boundary',
      pull.items[0].id === 'r0' && pull.items[49].id === 'r49' && pull.items[50].id === 'r50'
        && pull.items[119].id === 'r119',
      JSON.stringify([pull.items[0], pull.items[50]]));
    ok('the requested page size is passed through unchanged',
      requests.every((r) => r.pageSize === 50));
  }
  {
    // An exactly-full last page is indistinguishable from a full page with more behind it, so the
    // next page has to be asked for before the pull can claim to be complete.
    const { fetchPage, requests } = fakeServer(100);
    const pull = await collectPages(fetchPage, 50);
    ok('an exact multiple of the page size still confirms the end with one more request',
      requests.length === 3 && pull.complete === true, JSON.stringify(requests));
    ok('and no records are duplicated by that extra request',
      pull.items.length === 100 && new Set(pull.items.map((r) => r.id)).size === 100);
  }

  console.log('collectPages - failures:');
  {
    const failing = async () => { throw new Error('offline'); };
    let threw = false;
    try {
      await collectPages(failing, 50);
    } catch (e) {
      threw = e instanceof Error && e.message === 'offline';
    }
    ok('a first-page failure throws, so the caller skips the merge instead of reading an empty collection',
      threw);
  }
  {
    const fetchPage = async (page: number, pageSize: number) => {
      if (page === 2) throw new Error('connection reset');
      return Array.from({ length: pageSize }, (_, i) => ({ id: `r${(page - 1) * pageSize + i}` }));
    };
    const pull = await collectPages(fetchPage, 50);
    ok('a later-page failure keeps the pages that arrived', pull.items.length === 50,
      String(pull.items.length));
    ok('and reports the pull as incomplete so nothing gets deleted', pull.complete === false);
  }
  {
    // FastAPI returns a JSON object for an error the client did not raise on, and a `for...of` over
    // one would throw something far less obvious than this.
    const notAnArray = async () => ({ detail: 'Not authenticated' } as any);
    let message = '';
    try {
      await collectPages(notAnArray, 50);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    ok('a non-array response fails loudly and names the page',
      message.includes('page 1') && message.includes('object'), message);
  }

  console.log('collectPages - runaway server:');
  {
    const alwaysFull = async (page: number, pageSize: number) => {
      void page;
      return Array.from({ length: pageSize }, () => ({ id: 'same' }));
    };
    const requestCount = { n: 0 };
    const counted = async (page: number, pageSize: number) => {
      requestCount.n++;
      return alwaysFull(page, pageSize);
    };
    const pull = await collectPages(counted, 10);
    ok('a server that never returns a short page is cut off at the page ceiling',
      requestCount.n === MAX_PAGES_PER_PULL, String(requestCount.n));
    ok('and the truncated pull is incomplete, so absence still proves nothing',
      pull.complete === false && pull.items.length === MAX_PAGES_PER_PULL * 10,
      JSON.stringify({ complete: pull.complete, count: pull.items.length }));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
