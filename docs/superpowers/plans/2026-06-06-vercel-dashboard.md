# Sub-project D: Dashboard on Vercel (reads Supabase) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. The frontend has no test harness, so verification is `npm run lint` + manual browser checks.

**Goal:** Host the React dashboard on Vercel and have it read insights **directly from Supabase** (the deployed frontend cannot reach the local FastAPI backend), including showing `pending`/`processing` reels as placeholders that fill in once the worker finishes.

**Architecture:** Add a `supabase-js` client to the frontend. Repoint the read path (`fetchReels`, clusters) from `${API_BASE_URL}/reels` to Supabase queries with a **select-only** anon key. Clusters are computed client-side from the loaded reels. The LLM "Recompute clusters" action stays server-side (local backend) and is shown only when that backend is reachable.

**Tech Stack:** React 19 + Vite, `@supabase/supabase-js`, Supabase RLS, Vercel.

---

## Prerequisites

1. **Sub-project A merged** — `saved_reels` in Supabase with `status` column; data migrated.
2. Supabase **anon** key + project URL.
3. (Sub-project C enabled RLS.) This plan adds the **select** policy for anon.

---

### Task 1: Select-only RLS policy for the dashboard

**Files:** none (Supabase SQL Editor).

- [ ] **Step 1: Add an anon select policy**

```sql
create policy "anon read reels"
on saved_reels for select
to anon
using (true);
```

Now the anon key can read all reels (personal tool — acceptable) but still cannot update/delete (no such policies). Combined with sub-project C's insert-only policy, anon = read + enqueue, nothing destructive.

- [ ] **Step 2: Verify anon can now read**

```bash
curl -s "https://<proj>.supabase.co/rest/v1/saved_reels?select=id&limit=1" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
```

Expected: a JSON array containing one row id.

---

### Task 2: Supabase client + env in the frontend

**Files:**
- Modify: `frontend/package.json` (add dependency)
- Create: `frontend/src/supabaseClient.js`
- Create: `frontend/.env.local` (local dev; gitignored)
- Create: `frontend/.env.example` (committed reference)

- [ ] **Step 1: Install the client**

Run: `cd frontend; npm install @supabase/supabase-js`
Expected: adds `@supabase/supabase-js` to `package.json` dependencies.

- [ ] **Step 2: Create `frontend/src/supabaseClient.js`**

```javascript
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Null when unconfigured (e.g. a pure-local run that still talks to FastAPI).
export const supabase = url && anonKey ? createClient(url, anonKey) : null;

/** Map a Supabase row to the record shape the UI already renders. */
export function rowToRecord(r) {
  let ej = r.extracted_json;
  if (typeof ej === 'string') {
    try { ej = JSON.parse(ej); } catch { ej = {}; }
  }
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    raw_transcript: r.raw_transcript,
    post_caption: r.post_caption,
    extracted_json: ej || {},
    created_at: r.created_at,
    cluster: r.cluster || 'Unclustered',
    status: r.status || 'done',
  };
}
```

- [ ] **Step 3: Create env files**

`frontend/.env.example` (committed):

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
# Optional: local FastAPI backend for the Recompute action
VITE_API_URL=http://localhost:8000
```

`frontend/.env.local` (NOT committed — real values):

```
VITE_SUPABASE_URL=https://<proj>.supabase.co
VITE_SUPABASE_ANON_KEY=<ANON_KEY>
VITE_API_URL=http://localhost:8000
```

- [ ] **Step 4: Commit (scaffolding only)**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/supabaseClient.js frontend/.env.example
git commit -m "feat(frontend): add supabase-js client + env scaffolding"
```

---

### Task 3: Repoint reads to Supabase

**Files:**
- Modify: `frontend/src/App.jsx` — import the client; rewrite `fetchReels`; derive clusters client-side; mark `handleRecompute` backend-dependent.

- [ ] **Step 1: Import the client**

Near the top imports of `frontend/src/App.jsx` add:

```jsx
import { supabase, rowToRecord } from './supabaseClient';
```

- [ ] **Step 2: Add a client-side cluster helper**

Above the component (or near other helpers) add:

```jsx
function computeClusters(reels) {
  const counts = {};
  for (const r of reels) {
    const c = r.cluster || 'Unclustered';
    counts[c] = (counts[c] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}
```

- [ ] **Step 3: Rewrite `fetchReels` (and fold clusters in)**

Replace `fetchReels` (`App.jsx:93-103`) with:

```jsx
  const fetchReels = async () => {
    try {
      if (supabase) {
        const { data, error } = await supabase
          .from('saved_reels')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(500);
        if (error) throw error;
        const mapped = (data || []).map(rowToRecord);
        setReels(mapped);
        setClusters(computeClusters(mapped));
        return;
      }
      // Fallback: local FastAPI backend
      const response = await fetch(`${API_BASE_URL}/reels?limit=500`);
      if (response.ok) {
        const data = await response.json();
        setReels(data);
        setClusters(computeClusters(data));
      }
    } catch (err) {
      console.error('Error fetching reels', err);
    }
  };
```

- [ ] **Step 4: Make `fetchClusters` a no-op alias (clusters now derive from reels)**

Replace `fetchClusters` (`App.jsx:105-112`) with:

```jsx
  const fetchClusters = async () => {
    // Clusters are derived from the loaded reels (see fetchReels/computeClusters).
    // Kept as a callable so existing call sites (e.g. after recompute) still work.
  };
```

- [ ] **Step 5: Keep `handleRecompute` server-side, refetch from Supabase**

`handleRecompute` already POSTs to `${API_BASE_URL}/clusters/recompute`. Leave that call (it needs the LLM + service key — local backend only). After it succeeds, `fetchReels()` re-reads from Supabase (now including updated `cluster` values). No change to the function body is required, but confirm the `await fetchReels();` line remains and remove the now-redundant `await fetchClusters();` line in `handleRecompute` (`App.jsx:124`).

- [ ] **Step 6: Run lint**

Run: `cd frontend; npm run lint`
Expected: no new errors.

- [ ] **Step 7: Manual local check**

With `.env.local` set and the local backend running, `npm run dev` → the dashboard loads reels from Supabase; the cluster dropdown is populated; Recompute still works (hits local backend).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/App.jsx
git commit -m "feat(frontend): read reels + clusters from Supabase, derive clusters client-side"
```

---

### Task 4: Show pending/processing reels as placeholders

**Files:**
- Modify: `frontend/src/App.jsx` — guard card/table rendering on `status`.

- [ ] **Step 1: Gate the Recompute button on a reachable backend**

The deployed dashboard has no local backend, so Recompute would fail there. Find the Recompute button JSX and wrap it so it only renders when the backend is awake:

```jsx
{!isWakingUp && (
  /* existing Recompute button JSX */
)}
```

(`isWakingUp` is already driven by the `/health` poll; on Vercel with no reachable backend it stays true, hiding the button. Locally it goes false, showing it.)

- [ ] **Step 2: Render a placeholder for not-yet-processed reels**

In the card grid render, where each reel's insights are shown, add an early branch for non-`done` rows. At the top of the per-reel render (inside the `.map`), add:

```jsx
                  if (reel.status && reel.status !== 'done') {
                    return (
                      <div key={reel.id} className="reel-card glass" style={{ opacity: 0.7 }}>
                        <p style={{ fontWeight: 600 }}>{reel.title || 'Queued reel'}</p>
                        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                          {reel.status === 'processing' ? 'Processing…' : reel.status === 'failed' ? 'Failed' : 'Queued'}
                        </p>
                        {reel.url && (
                          <a href={reel.url} target="_blank" rel="noreferrer" style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>{reel.url}</a>
                        )}
                      </div>
                    );
                  }
```

(Adjust the exact JSX/class names to match the existing card markup — the point is: non-`done` rows render a lightweight placeholder instead of trying to read empty `extracted_json`.)

- [ ] **Step 3: Optional — live refresh while processing**

So shared reels appear without a manual reload, add a poll while any reel is pending/processing. Near the other `useEffect`s:

```jsx
  useEffect(() => {
    const anyPending = reels.some(r => r.status && r.status !== 'done' && r.status !== 'failed');
    if (!anyPending) return;
    const id = setInterval(fetchReels, 5000);
    return () => clearInterval(id);
  }, [reels]);
```

- [ ] **Step 4: Run lint + manual check**

Run: `cd frontend; npm run lint`
Expected: clean.

Manual: insert a `pending` row in Supabase → it appears as a "Queued" placeholder → worker processes it → within ~5s it flips to a full insight card (via the poll).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.jsx
git commit -m "feat(frontend): placeholders for queued/processing reels + live refresh"
```

---

### Task 5: Deploy to Vercel

**Files:** none (Vercel dashboard / CLI).

- [ ] **Step 1: Set the project root**

Vercel project → Settings → **Root Directory** = `frontend` (the SPA lives there). Framework preset: **Vite**.

- [ ] **Step 2: Add environment variables in Vercel**

Project → Settings → Environment Variables (Production + Preview):
- `VITE_SUPABASE_URL` = `https://<proj>.supabase.co`
- `VITE_SUPABASE_ANON_KEY` = `<ANON_KEY>`
- Leave `VITE_API_URL` **unset** in production (no reachable backend → Recompute hidden; reads go to Supabase).

- [ ] **Step 3: Deploy**

Run: `cd frontend; npx vercel --prod` (or push to the connected branch).
Expected: a successful build + a public URL.

- [ ] **Step 4: Verify the deployed dashboard**

Open the Vercel URL on desktop and on the iPhone:
- Reels load (from Supabase). Cluster dropdown populated.
- Recompute button is **hidden** (no backend).
- Share a reel via the Shortcut → a "Queued" card appears within the poll interval, then fills once the local worker processes it.

---

## Self-Review

- **Spec coverage (sub-project D):** dashboard hosted on Vercel ✓ (Task 5); reads Supabase directly via supabase-js, not local FastAPI ✓ (Tasks 2–3); select-only anon RLS ✓ (Task 1); clusters handled (derived client-side) ✓ (Task 3); recompute stays server-side, hidden when backend unreachable ✓ (Task 4 Step 1); `status` placeholders + live refresh ✓ (Task 4); env `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` ✓ (Tasks 2 & 5).
- **Placeholder scan:** `<proj>`/`<ANON_KEY>` are user-supplied values (Prerequisites). Task 4 Step 2 explicitly says to match existing card markup — an instruction, not an unfinished step.
- **Type consistency:** `rowToRecord` output matches the record shape used everywhere else (`id,url,title,raw_transcript,post_caption,extracted_json,created_at,cluster`) plus `status`. `computeClusters(reels) -> [{name,count}]` matches the `clusters` state shape the dropdown consumes. `fetchReels`/`fetchClusters` keep their existing call signatures so other call sites are unaffected.
- **Fallback:** when `supabase` is null (pure-local run without env), reads fall back to the FastAPI backend — local dev keeps working either way.
```
