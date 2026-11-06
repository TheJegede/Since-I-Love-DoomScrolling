import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

/** The signed-in owner's session (null when signed out); `loading` until Supabase has answered once. */
export function useSession() {
  const [state, setState] = useState({ session: null, loading: Boolean(supabase) });

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) setState({ session: data.session, loading: false });
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) setState({ session, loading: false });
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  return state;
}
