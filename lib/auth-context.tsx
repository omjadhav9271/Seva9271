'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase, Profile } from './supabase';

type AuthContextType = {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  /* Does this account own a service_providers row?
     🔴 NOT derivable from `profile.role`. An APPROVED provider still carries role='customer' —
     verified on the live DB — because a provider books services like anyone else and the column
     holds one value. Reading role here would hide the provider UI from every real provider. The
     only truth is owning a row, so it is fetched once per session and shared rather than
     re-queried by every component that needs to ask. */
  isProvider: boolean;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<{ error: string | null }>;
  updatePassword: (password: string) => Promise<{ error: string | null }>;
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  profile: null,
  isProvider: false,
  loading: true,
  signIn: async () => ({ error: null }),
  signUp: async () => ({ error: null }),
  signOut: async () => {},
  requestPasswordReset: async () => ({ error: null }),
  updatePassword: async () => ({ error: null }),
  refreshProfile: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isProvider, setIsProvider] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchProfile = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (data) setProfile(data as Profile);
    /* head: true — this asks whether a row EXISTS, not what is in it. Read through
       my_provider_profile (the auth.uid()-filtered view) because service_providers withholds
       several columns from `authenticated` at the column level. supabase-js resolves rather than
       throws on error, so a failure here cannot stop `loading` from settling. */
    const { count } = await supabase
      .from('my_provider_profile')
      .select('id', { count: 'exact', head: true });
    setIsProvider((count ?? 0) > 0);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (user) await fetchProfile(user.id);
  }, [user, fetchProfile]);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        if (!mounted) return;
        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) {
          fetchProfile(session.user.id).finally(() => {
            if (mounted) setLoading(false);
          });
        } else {
          setLoading(false);
        }
      })
      // `loading` must ALWAYS settle: pages gate their auth redirect on it, so a
      // rejected getSession (offline, DNS failure) would otherwise leave them
      // parked on a spinner forever instead of falling through to signed-out.
      .catch((err) => {
        console.error('Failed to restore session:', err);
        if (!mounted) return;
        setSession(null);
        setUser(null);
        setLoading(false);
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchProfile(session.user.id);
      } else {
        setIsProvider(false);
        setProfile(null);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [fetchProfile]);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  };

  const signUp = async (email: string, password: string, fullName: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    // supabase-js defaults this to `scope: 'global'`, which revokes every refresh token for the
    // user rather than just this tab's. That is the behaviour we want and rely on after a password
    // reset, so it is stated here rather than left to a library default that could change.
    await supabase.auth.signOut({ scope: 'global' });
    setIsProvider(false);
    setProfile(null);
  };

  /* Send the recovery email. `redirectTo` is where Supabase bounces the browser after it verifies
     the token, and it must be on the project's redirect allowlist (Auth → URL Configuration) or
     Supabase silently falls back to the Site URL — which would land the user on `/` with a live
     recovery session and no way to set a password.

     Deliberately returns the SAME result whether or not the address has an account: Supabase does
     not send mail to an unknown address but still reports success, and the UI must not undo that
     by saying "no such user". A reset form that distinguishes the two is an account-enumeration
     oracle for anyone who wants to know who is on Seva. */
  const requestPasswordReset = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    });
    return { error: error?.message ?? null };
  };

  /* Set a new password for whoever the CURRENT session belongs to — on the reset page that is the
     recovery session Supabase established from the emailed link.

     Note what this does NOT do: it does not revoke the user's other sessions. That is the caller's
     job (see the reset page), and it matters, because the person most likely to be resetting a
     password is someone who thinks another party has it. */
  const updatePassword = async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password });
    return { error: error?.message ?? null };
  };

  return (
    <AuthContext.Provider value={{
      user, session, profile, isProvider, loading,
      signIn, signUp, signOut, requestPasswordReset, updatePassword, refreshProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
