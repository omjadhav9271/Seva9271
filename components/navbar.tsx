'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import {
  Bell, Wallet, Menu, X, LogOut, User, BookOpen,
  Heart, Settings, HelpCircle, ArrowUpRight, ArrowDownLeft, TrendingUp,
  CheckCircle, Info, AlertTriangle, AlertCircle, ShieldCheck, type LucideIcon
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase, type Notification } from '@/lib/supabase';

/* Two entries, each answering a question the other cannot.
   Services = "what can I get" (the 25-category directory); Providers = "who is near me" (the
   ranked list). They used to be the same ranked list twice, ~450 duplicated lines apart, which is
   a navigation you have to guess at rather than read.

   GONE FROM HERE:
   · "How It Works" — it is already a footer link (footer.tsx), so a top-level tab was the same
     destination twice in one viewport.
   · "Become a Provider" — moved to `customerLinks` below, because inviting someone who already
     runs an approved provider profile to become a provider is a control that cannot do anything. */
const navLinks = [
  { href: '/services', label: 'Services' },
  { href: '/providers', label: 'Providers' },
];

// Shown only to accounts that do NOT already own a provider profile. See `isProvider` in
// auth-context: profiles.role does not track this — an approved provider still reads 'customer'.
const customerLinks = [
  { href: '/become-provider', label: 'Become a Provider' },
];

// An admin is not a customer with extra buttons. They never book, never hold a wallet balance and
// certainly never "Become a Provider" — offering those is noise that also implies capabilities the
// account does not have. Give them the three surfaces they actually work in.
const adminLinks = [
  { href: '/admin', label: 'Admin' },
  { href: '/admin/disputes', label: 'Disputes' },
  { href: '/admin/providers', label: 'Providers' },
  { href: '/admin/categories', label: 'Categories' },
];

// Colour + icon per notification type (info / success / warning / error).
const notifStyles: Record<Notification['type'], { icon: LucideIcon; color: string }> = {
  info: { icon: Info, color: '#3b82f6' },
  success: { icon: CheckCircle, color: '#22c55e' },
  warning: { icon: AlertTriangle, color: '#FF9933' },
  error: { icon: AlertCircle, color: '#ef4444' },
};

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const { user, profile, isProvider, signOut, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // Admin navigation replaces the customer navigation rather than adding to it. `role` is
  // server-controlled (not client-writable) and every admin page + its RLS re-checks it, so this
  // is presentation only — hiding a link has never been the boundary.
  const isAdmin = profile?.role === 'admin';
  /* Signed out, there are NO nav links — every one of them points at a page that now sits behind
     AuthGate, so offering them means offering four controls that bounce straight back to the
     sign-in page the visitor is already on. A link that doesn't go where it says is worse than no
     link: honest signposting, the same rule that removed the hero's dead ?location= box.

     Keyed on `user` rather than `!loading && !user`, so the links appear only once we know there
     IS someone — never optimistically, which would flash four dead links at a signed-out visitor
     on every load. There is no cost to the signed-in case: a gated page renders nothing but
     "Loading…" during that same window anyway. */
  const links = !user ? []
    : isAdmin ? adminLinks
    : isProvider ? navLinks
    : [...navLinks, ...customerLinks];

  const walletRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
    setUserMenuOpen(false);
    setWalletOpen(false);
    setNotificationsOpen(false);
  }, [pathname]);

  // Real notifications for the signed-in user: initial fetch + live inserts.
  useEffect(() => {
    const uid = user?.id;
    if (!uid) {
      setNotifications([]);
      return;
    }

    let active = true;
    supabase
      .from('notifications')
      .select('*')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (active && data) setNotifications(data as Notification[]);
      });

    const channel = supabase
      .channel(`notifications:${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` },
        (payload) => setNotifications((prev) => [payload.new as Notification, ...prev]),
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (walletRef.current && !walletRef.current.contains(e.target as Node)) setWalletOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotificationsOpen(false);
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const tierColors: Record<string, string> = {
    silver: 'from-slate-400 to-slate-500',
    gold: 'from-amber-400 to-amber-500',
    platinum: 'from-slate-300 to-slate-400',
  };

  const tierBadgeColors: Record<string, string> = {
    silver: 'bg-slate-500 text-white',
    gold: 'bg-amber-500 text-white',
    platinum: 'bg-slate-300 text-slate-900',
  };

  const handleSignOut = async () => {
    await signOut();
    router.push('/');
  };

  // Real values only. These used to fall back to ₹12,450 / 'gold' placeholder data, so for the
  // moment before the profile row arrives — and for any user whose fetch fails — the navbar showed
  // a balance that was not theirs. Money must never be invented in the UI.
  const balance = profile?.wallet_balance ?? 0;
  const tier = profile?.wallet_tier ?? 'silver';
  const monthlyReward = Math.round((balance * 0.08) / 12);

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  // Mark the user's unread notifications read (clears the badge). Optimistic + server update.
  const markAllRead = async () => {
    if (!user || unreadCount === 0) return;
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', user.id)
      .eq('is_read', false);
  };

  const toggleNotifications = () => {
    const willOpen = !notificationsOpen;
    setNotificationsOpen(willOpen);
    setWalletOpen(false);
    setUserMenuOpen(false);
    if (willOpen) markAllRead();
  };

  // Open a notification: close the dropdown, mark just this one read, go to its source (if any).
  const openNotification = (n: Notification) => {
    setNotificationsOpen(false);
    if (!n.is_read) {
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
      supabase.from('notifications').update({ is_read: true }).eq('id', n.id);
    }
    if (n.link) router.push(n.link);
  };

  const closeAll = () => {
    setWalletOpen(false);
    setNotificationsOpen(false);
    setUserMenuOpen(false);
  };

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled || menuOpen
          ? 'bg-[#0d0d0d]/95 backdrop-blur-md border-b border-[#2a2a2a]'
          : 'bg-transparent'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo. Home is gated too, so signed out it points at the sign-in page instead of
              bouncing off / on the way there. */}
          <Link href={user ? '/' : '/auth/signin'} className="flex items-center gap-2 flex-shrink-0">
            <span className="text-2xl">🙏</span>
            <span className="text-xl font-bold text-[#138808]">Seva</span>
            <span className="text-2xl">🙏</span>
          </Link>

          {/* Desktop Nav Links */}
          <div className="hidden md:flex items-center gap-6">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`text-sm font-medium transition-colors duration-200 ${
                  pathname === link.href
                    ? 'text-[#FF9933]'
                    : 'text-gray-300 hover:text-white'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>

          {/* Right Side.

              GONE FROM HERE: a location chip reading "Mumbai, MH". It was a <button> with hover
              styling and NO onClick — a dead control, the thing this codebase keeps deleting. It
              also invented its own data: the fallback was a hardcoded "Mumbai, MH", so every user
              without a city on their profile was told they were in Mumbai, and a signed-out
              visitor (no user at all) was told the same. And it duplicated something that already
              works — /providers and /services carry the real GPS + pincode control and say what
              they are searching near ("Searching near 400064"). A chip in the chrome implying a
              global "you are here" that no search reads is worse than no chip. */}
          <div className="hidden md:flex items-center gap-3">
            {!loading && (
              <>
                {user ? (
                  <>
                    {/* Wallet Button + Dropdown — customers and providers only. An admin holds no
                        balance and cannot top up or withdraw, so the control is hidden rather than
                        shown reading ₹0. */}
                    {!isAdmin && (
                    <div className="relative" ref={walletRef}>
                      <button
                        onClick={() => { setWalletOpen(!walletOpen); setNotificationsOpen(false); setUserMenuOpen(false); }}
                        className="flex items-center gap-2 bg-[#1e1e1e] border border-[#2a2a2a] rounded-full px-3 py-1.5 text-sm hover:border-[#FF9933]/50 transition-colors"
                      >
                        <Wallet className="w-4 h-4 text-[#FF9933]" />
                        <span className="font-semibold text-white">
                          ₹{balance.toLocaleString('en-IN')}
                        </span>
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full capitalize ${tierBadgeColors[tier]}`}>
                          {tier.charAt(0).toUpperCase() + tier.slice(1)}
                        </span>
                      </button>

                      {walletOpen && (
                        <div className="absolute right-0 mt-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-2xl shadow-2xl overflow-hidden">
                          <div className="px-5 py-4 border-b border-[#2a2a2a]">
                            <p className="font-bold text-white text-base">Wallet & Rewards</p>
                          </div>
                          <div className="px-5 py-4 space-y-3 border-b border-[#2a2a2a]">
                            <div className="flex items-center justify-between">
                              <span className="text-sm text-gray-400">Balance:</span>
                              <span className="text-sm font-bold text-white">₹{balance.toLocaleString('en-IN')}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-sm text-gray-400">Monthly Rewards:</span>
                              <span className="text-sm font-bold text-[#22c55e]">+₹{monthlyReward}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-sm text-gray-400">Tier:</span>
                              <span className={`text-xs font-bold px-2 py-0.5 rounded-full capitalize ${tierBadgeColors[tier]}`}>
                                {tier.charAt(0).toUpperCase() + tier.slice(1)}
                              </span>
                            </div>
                          </div>
                          <div className="py-2">
                            <Link
                              href="/wallet"
                              onClick={closeAll}
                              className="flex items-center gap-3 px-5 py-2.5 text-sm text-gray-300 hover:bg-[#252525] hover:text-white transition-colors"
                            >
                              <ArrowDownLeft className="w-4 h-4 text-[#22c55e]" />
                              Top Up Wallet
                            </Link>
                            <Link
                              href="/wallet"
                              onClick={closeAll}
                              className="flex items-center gap-3 px-5 py-2.5 text-sm text-gray-300 hover:bg-[#252525] hover:text-white transition-colors"
                            >
                              <ArrowUpRight className="w-4 h-4 text-[#FF9933]" />
                              Withdraw Funds
                            </Link>
                            <Link
                              href="/wallet"
                              onClick={closeAll}
                              className="flex items-center gap-3 px-5 py-2.5 text-sm text-gray-300 hover:bg-[#252525] hover:text-white transition-colors"
                            >
                              <TrendingUp className="w-4 h-4 text-blue-400" />
                              Transaction History
                            </Link>
                          </div>
                        </div>
                      )}
                    </div>
                    )}

                    {/* Notifications Button + Dropdown — admins need these too: a raised dispute
                        notifies every admin and links straight to the case. */}
                    <div className="relative" ref={notifRef}>
                      <button
                        onClick={toggleNotifications}
                        className="relative p-2 rounded-full bg-[#1e1e1e] border border-[#2a2a2a] hover:border-[#FF9933]/50 transition-colors"
                      >
                        <Bell className="w-4 h-4 text-gray-300" />
                        {unreadCount > 0 && (
                          <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 bg-[#FF9933] rounded-full text-[10px] font-bold text-white flex items-center justify-center">
                            {unreadCount > 9 ? '9+' : unreadCount}
                          </span>
                        )}
                      </button>

                      {notificationsOpen && (
                        <div className="absolute right-0 mt-2 w-80 bg-[#1a1a1a] border border-[#2a2a2a] rounded-2xl shadow-2xl overflow-hidden">
                          <div className="px-5 py-4 border-b border-[#2a2a2a]">
                            <p className="font-bold text-white text-base">Notifications</p>
                          </div>
                          {notifications.length === 0 ? (
                            <div className="px-5 py-8 text-center text-sm text-gray-500">
                              No notifications yet
                            </div>
                          ) : (
                            <div className="divide-y divide-[#222] max-h-96 overflow-y-auto">
                              {notifications.map((n) => {
                                const { icon: Icon, color } = notifStyles[n.type] ?? notifStyles.info;
                                return (
                                  <button
                                    key={n.id}
                                    type="button"
                                    onClick={() => openNotification(n)}
                                    className="w-full text-left flex items-start gap-3 px-5 py-3.5 hover:bg-[#252525] transition-colors cursor-pointer"
                                  >
                                    <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: `${color}20` }}>
                                      <Icon className="w-4 h-4" style={{ color }} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-semibold text-white">{n.title}</p>
                                      <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{n.message}</p>
                                      <p className="text-[11px] text-gray-600 mt-1">{timeAgo(n.created_at)}</p>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          <div className="px-5 py-3 border-t border-[#2a2a2a]">
                            <Link
                              href="/notifications"
                              onClick={closeAll}
                              className="text-sm text-[#FF9933] hover:text-[#e8872e] font-medium transition-colors"
                            >
                              View All Notifications
                            </Link>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* User Menu */}
                    <div className="relative" ref={userRef}>
                      <button
                        onClick={() => { setUserMenuOpen(!userMenuOpen); setWalletOpen(false); setNotificationsOpen(false); }}
                        className="flex items-center gap-1.5 p-1 rounded-full bg-[#1e1e1e] border border-[#2a2a2a] hover:border-[#FF9933]/50 transition-colors"
                      >
                        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#FF9933] to-[#138808] flex items-center justify-center text-xs font-bold text-white">
                          {profile?.full_name?.[0]?.toUpperCase() ?? user.email?.[0]?.toUpperCase() ?? 'U'}
                        </div>
                      </button>

                      {userMenuOpen && (
                        <div className="absolute right-0 mt-2 w-56 bg-[#1a1a1a] border border-[#2a2a2a] rounded-2xl shadow-2xl overflow-hidden">
                          <div className="px-4 py-3.5 border-b border-[#2a2a2a]">
                            {/* No invented identity: show what we have, or nothing. */}
                            <p className="text-sm font-bold text-white truncate">{profile?.full_name?.trim() || user.email || 'Your account'}</p>
                            {profile?.full_name?.trim() && user.email && (
                              <p className="text-xs text-gray-400 truncate mt-0.5">{user.email}</p>
                            )}
                            {isAdmin && (
                              <span className="inline-block mt-1.5 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-[#FF9933]/15 text-[#FF9933]">
                                Admin
                              </span>
                            )}
                          </div>
                          <div className="py-1.5">
                            <Link href="/profile" onClick={closeAll} className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-[#252525] hover:text-white transition-colors">
                              <User className="w-4 h-4 text-gray-500" /> Profile
                            </Link>
                            {/* Bookings and favourites belong to people who book. An admin has
                                neither, and the admin console is what they came for. */}
                            {isAdmin ? (
                              <Link href="/admin" onClick={closeAll} className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-[#252525] hover:text-white transition-colors">
                                <ShieldCheck className="w-4 h-4 text-gray-500" /> Admin console
                              </Link>
                            ) : (
                              <>
                                <Link href="/bookings" onClick={closeAll} className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-[#252525] hover:text-white transition-colors">
                                  <BookOpen className="w-4 h-4 text-gray-500" /> My Bookings
                                </Link>
                                <Link href="/profile" onClick={closeAll} className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-[#252525] hover:text-white transition-colors">
                                  <Heart className="w-4 h-4 text-gray-500" /> Favorites
                                </Link>
                              </>
                            )}
                            <Link href="/profile" onClick={closeAll} className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-[#252525] hover:text-white transition-colors">
                              <Settings className="w-4 h-4 text-gray-500" /> Settings
                            </Link>
                            <Link href="/how-it-works" onClick={closeAll} className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-[#252525] hover:text-white transition-colors">
                              <HelpCircle className="w-4 h-4 text-gray-500" /> Help & Support
                            </Link>
                          </div>
                          <div className="border-t border-[#2a2a2a] py-1.5">
                            <button
                              onClick={handleSignOut}
                              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-red-400 hover:bg-red-900/20 hover:text-red-300 transition-colors"
                            >
                              <LogOut className="w-4 h-4" /> Sign out
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                ) : null /* No "Sign In" / "Get Started" pair here any more.

                    Signed out, the only pages that exist are the four /auth ones — so those two
                    buttons were shown exclusively to people who were already standing on one of
                    them. On each page one of the two is CIRCULAR (a "Sign In" button on the
                    sign-in page) and the other is already offered in the page's own body, in the
                    place people actually look for it: "Don't have an account? Sign up free",
                    "Already have an account? Sign in", "Back to sign in", "Send me a new link".

                    So the pair was never a way in — it was two extra controls that either did
                    nothing visible or duplicated the sentence below them. Same rule that emptied
                    the nav links and the footer's service column: a control that returns you to
                    where you already are is worse than no control. */}
              </>
            )}
          </div>

          {/* Mobile menu button — only when there is a menu to open.
              Signed out the panel below holds nothing at all now (no nav links, and the auth pair
              is gone for the reason above), so an always-rendered hamburger would be a control
              that opens an empty box. */}
          {user && (
            <button
              className="md:hidden p-2 rounded-lg text-gray-300 hover:text-white transition-colors"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          )}
        </div>
      </div>

      {/* Mobile Menu. Gated on `user` as well as `menuOpen` — otherwise signing out with the menu
          open leaves an empty panel hanging under the navbar. */}
      {menuOpen && user && (
        <div className="md:hidden bg-[#0d0d0d] border-t border-[#2a2a2a]">
          <div className="px-4 py-4 space-y-2">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`block px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                  pathname === link.href
                    ? 'bg-[#FF9933]/10 text-[#FF9933]'
                    : 'text-gray-300 hover:bg-[#1e1e1e] hover:text-white'
                }`}
              >
                {link.label}
              </Link>
            ))}
            {/* No signed-out branch: this panel only renders for a signed-in user now. */}
            <div className="pt-2 border-t border-[#2a2a2a]">
              <div className="space-y-2">
                <Link href="/profile" className="block px-4 py-3 rounded-lg text-sm text-gray-300 hover:bg-[#1e1e1e] hover:text-white">Profile</Link>
                {/* Mirrors the desktop menu — an admin gets neither bookings nor a wallet. */}
                {!isAdmin && (
                  <>
                    <Link href="/bookings" className="block px-4 py-3 rounded-lg text-sm text-gray-300 hover:bg-[#1e1e1e] hover:text-white">My Bookings</Link>
                    <Link href="/wallet" className="block px-4 py-3 rounded-lg text-sm text-gray-300 hover:bg-[#1e1e1e] hover:text-white">Wallet</Link>
                  </>
                )}
                <button onClick={handleSignOut} className="block w-full text-left px-4 py-3 rounded-lg text-sm text-red-400 hover:bg-red-900/20">Sign out</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
