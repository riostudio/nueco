/**
 * Yields control back to the JS event loop (macrotask). Used to break up long
 * synchronous loops - e.g. decrypting a whole notes/events collection in one pass -
 * so they don't block touch handling and animations for the loop's full duration.
 */
export function yieldToJS(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
