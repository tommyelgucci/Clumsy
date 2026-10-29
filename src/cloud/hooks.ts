import { useEffect, useState } from 'react';
import type { CloudUser } from './auth';
import { cloudAvailable } from './config';

/** The signed-in user (null when signed out or the cloud isn't configured).
 *  `ready` is false until Firebase has reported the initial auth state, so
 *  the UI doesn't flash "signed out" while it restores a session. Firebase
 *  itself is imported on demand: an unconfigured app never loads it. */
export function useCloudUser(): { user: CloudUser | null; ready: boolean } {
  const [state, setState] = useState<{ user: CloudUser | null; ready: boolean }>({ user: null, ready: !cloudAvailable });
  useEffect(() => {
    if (!cloudAvailable) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void import('./auth').then((auth) => {
      if (!cancelled) unsubscribe = auth.watchUser((user) => setState({ user, ready: true }));
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
  return state;
}

/** Whether the signed-in user has an active subscription (task 3.5) — false
 *  while loading, signed out, or when there's no cloud, so the free plan is
 *  always the fallback. */
export function useEntitlement(uid: string | null): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!cloudAvailable || !uid) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void import('./clips').then((clips) => {
      if (!cancelled) unsubscribe = clips.watchEntitlement(uid, setActive);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
      setActive(false);
    };
  }, [uid]);
  return active;
}
