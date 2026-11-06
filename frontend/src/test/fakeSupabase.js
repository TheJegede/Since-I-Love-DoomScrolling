// Minimal stand-in for the supabase-js query chains App.jsx uses. getRows() is the saved_reels table.
export function fakeSupabase(getRows) {
  const query = () => {
    const q = {
      select: () => q,
      order: () => q,
      eq: () => q,
      in: () => Promise.resolve({ data: [], error: null }),
      range: (from, to) => Promise.resolve({ data: getRows().slice(from, to + 1), error: null, count: getRows().length }),
      single: () => Promise.resolve({ data: { raw_transcript: '', post_caption: '' }, error: null }),
    };
    return q;
  };
  return { from: query, rpc: () => Promise.resolve({ data: [], error: null }) };
}
