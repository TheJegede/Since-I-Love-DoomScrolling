// In-memory stand-in for the supabase-js client. Queries run against plain arrays,
// so tests assert on the rows the code actually wrote.
export function createFakeSupabase({ getTable } = {}) {
  const fake = { tables: {}, uploads: [], removed: [], log: [], failures: [], session: null };
  const tableFor = (name) => getTable?.(name) ?? (fake.tables[name] ??= []);

  // The next `op` ('select' | 'insert' | 'update' | 'delete' | 'upload') on `table` fails with `error`.
  fake.failNext = (table, op, error) => fake.failures.push({ table, op, error });
  const takeFailure = (table, op) => {
    const i = fake.failures.findIndex(f => f.table === table && f.op === op);
    return i < 0 ? null : fake.failures.splice(i, 1)[0].error;
  };

  const from = (name) => {
    const q = { op: 'select', filters: [], orders: [], wantRows: true, mode: 'many' };
    const chain = (method, apply) => (...args) => {
      fake.log.push({ table: name, method, args });
      apply(...args);
      return builder;
    };
    const run = () => {
      const error = takeFailure(name, q.op);
      if (error) return { data: null, error };
      const rows = tableFor(name);
      const matches = (r) => q.filters.every(f => f(r));
      let data;
      if (q.op === 'insert') {
        data = [].concat(q.payload).map(r => ({ ...r }));
        rows.push(...data);
      } else if (q.op === 'update') {
        data = rows.filter(matches);
        data.forEach(r => Object.assign(r, q.payload));
      } else if (q.op === 'delete') {
        data = rows.filter(matches);
        data.forEach(r => rows.splice(rows.indexOf(r), 1));
      } else {
        data = rows.filter(matches);
      }
      for (const { column, ascending } of [...q.orders].reverse()) {
        data = [...data].sort((a, b) => (a[column] > b[column] ? 1 : a[column] < b[column] ? -1 : 0) * (ascending ? 1 : -1));
      }
      const count = data.length;
      if (q.range) data = data.slice(q.range[0], q.range[1] + 1);
      if (q.limit != null) data = data.slice(0, q.limit);
      if (q.mode === 'single') return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: 'expected one row' } };
      if (q.mode === 'maybeSingle') return { data: data[0] ?? null, error: null };
      return { data: q.wantRows ? data : null, error: null, count };
    };
    const builder = {
      select: chain('select', () => { q.wantRows = true; }),
      insert: chain('insert', (payload) => Object.assign(q, { op: 'insert', payload, wantRows: false })),
      update: chain('update', (payload) => Object.assign(q, { op: 'update', payload, wantRows: false })),
      delete: chain('delete', () => Object.assign(q, { op: 'delete', wantRows: false })),
      eq: chain('eq', (column, value) => q.filters.push(r => r[column] === value)),
      in: chain('in', (column, values) => q.filters.push(r => values.includes(r[column]))),
      gt: chain('gt', (column, value) => q.filters.push(r => new Date(r[column]) > new Date(value))),
      is: chain('is', (column) => q.filters.push(r => r[column] == null)),
      order: chain('order', (column, opts = {}) => q.orders.push({ column, ascending: opts.ascending !== false })),
      limit: chain('limit', (n) => { q.limit = n; }),
      range: chain('range', (start, end) => { q.range = [start, end]; }),
      single: chain('single', () => { q.mode = 'single'; }),
      maybeSingle: chain('maybeSingle', () => { q.mode = 'maybeSingle'; }),
      textSearch: chain('textSearch', () => q.filters.push(() => false)),
      then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  };

  const listeners = new Set();
  fake.setSession = (session, event = session ? 'SIGNED_IN' : 'SIGNED_OUT') => {
    fake.session = session;
    listeners.forEach(cb => cb(event, session));
  };

  fake.client = {
    from,
    rpc: () => Promise.resolve({ data: [], error: null }),
    storage: {
      from: (bucket) => ({
        upload: async (path) => {
          const error = takeFailure(bucket, 'upload');
          if (error) return { data: null, error };
          fake.uploads.push({ bucket, path });
          return { data: { path }, error: null };
        },
        remove: async (paths) => {
          fake.removed.push(...paths.map(path => ({ bucket, path })));
          return { data: [], error: null };
        },
      }),
    },
    auth: {
      getSession: async () => ({ data: { session: fake.session }, error: null }),
      onAuthStateChange: (cb) => {
        listeners.add(cb);
        return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
      },
      signInWithOtp: async (args) => {
        fake.log.push({ table: 'auth', method: 'signInWithOtp', args: [args] });
        return { data: {}, error: takeFailure('auth', 'signInWithOtp') };
      },
      signOut: async () => {
        fake.setSession(null);
        return { error: null };
      },
    },
  };
  return fake;
}

// Older App tests pass a function returning the saved_reels rows; the signed-in owner is assumed.
export function fakeSupabase(getRows) {
  const fake = createFakeSupabase({ getTable: name => (name === 'saved_reels' ? getRows() : undefined) });
  fake.session = { user: { id: 'owner' } };
  return fake.client;
}
