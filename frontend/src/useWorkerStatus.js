import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

const STALE_AFTER_MS = 15 * 60 * 1000;  // the scheduled worker runs every 5 minutes
const READ_EVERY_MS = 30 * 1000;

export const isWorkerStale = (lastSeen, now = Date.now()) => !lastSeen || now - lastSeen.getTime() > STALE_AFTER_MS;

/** "3 minutes", "2 hours", "4 days" since `date`. */
export function timeSince(date, now = Date.now()) {
  const minutes = Math.max(1, Math.round((now - date.getTime()) / 60000));
  const [value, unit] = minutes < 60 ? [minutes, 'minute']
    : minutes < 48 * 60 ? [Math.round(minutes / 60), 'hour']
    : [Math.round(minutes / 1440), 'day'];
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

/** When the home worker last checked in. `loaded` stays false until the first read succeeds. */
export function useWorkerStatus() {
  const [status, setStatus] = useState({ lastSeen: null, loaded: false });

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    const read = async () => {
      const { data, error } = await supabase.from('worker_status').select('last_seen').eq('id', 1).maybeSingle();
      if (!active) return;
      if (error) return console.error('Could not read worker status', error);
      setStatus({ lastSeen: data ? new Date(data.last_seen) : null, loaded: true });
    };
    read();
    const id = setInterval(read, READ_EVERY_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return status;
}
