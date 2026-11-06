import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({})) }));

afterEach(() => vi.unstubAllEnvs());

describe('supabaseClient', () => {
  it('pins the implicit auth flow, so a sign-in link opened on another device still works', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    vi.resetModules();
    const { createClient } = await import('@supabase/supabase-js');
    await import('../supabaseClient');
    expect(createClient).toHaveBeenCalledWith('https://project.supabase.co', 'anon-key', {
      auth: { flowType: 'implicit', persistSession: true, detectSessionInUrl: true },
    });
  });
});
