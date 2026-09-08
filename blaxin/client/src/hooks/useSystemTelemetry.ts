import { useEffect, useState } from 'react';
import { api, SystemTelemetry } from '../services/api';

// Polls only while the component using it is mounted (the System page is
// the only consumer), so nothing runs in the background on other pages.
const POLL_MS = 5000;

export function useSystemTelemetry() {
  const [data, setData] = useState<SystemTelemetry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const d = await api.getSystemTelemetry();
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { data, error };
}