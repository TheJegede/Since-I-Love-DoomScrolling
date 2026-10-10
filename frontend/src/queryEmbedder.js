// The same MiniLM model the backend embeds reels with (fastembed), so a query
// vector is comparable with the stored reel vectors. Changing either side
// means re-embedding every reel.
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

let embedderPromise = null;

/** Download (first use on a device) and initialise the model. A failed load can be retried. */
export function loadEmbedder() {
  if (!embedderPromise) {
    // Dynamic import keeps the model runtime out of the main bundle.
    embedderPromise = import('@huggingface/transformers')
      .then(({ pipeline }) => pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' }))
      .catch((err) => {
        embedderPromise = null;
        throw err;
      });
  }
  return embedderPromise;
}

/** Embed search text as a unit-length vector. */
export async function embedQuery(text) {
  const embedder = await loadEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}
