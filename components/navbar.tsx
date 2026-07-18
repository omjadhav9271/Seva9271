'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import {
  Bell, MapPin, Wallet, Menu, X, LogOut, User, BookOpen,
  Heart, Settings, HelpCircle, ArrowUpRight, ArrowDownLeft, TrendingUp,
  CheckCircle, Info, AlertTriangle, AlertCircle, type LucideIcon
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase, type Notification } from '@/lib/supabase';

const navLinks = [
  { href: '/services', label: 'Services' },
  { href: '/providers', label: 'Providers' },
  { href: '/how-it-works', label: 'How It Works' },
  { href: '/become-provider', label: 'Become a Provider' },
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

  const { user, profile, signOut, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

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

  const balance = profile?.wallet_balance ?? 12450;
  const tier = profile?.wallet_tier ?? 'gold';
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
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 flex-shrink-0">
            <span className="text-2xl">🙏</span>
            <span className="text-xl font-bold text-[#138808]">Seva</span>
            <span className="text-2xl">🙏</span>
          </Link>

          {/* Desktop Nav Links */}
          <div className="hidden md:flex items-center gap-6">
            {navLinks.map((link) => (
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

          {/* Right Side */}
          <div className="hidden md:flex items-center gap-3">
            {/* Location */}
            <button className="flex items-center gap-1.5 text-sm text-gray-300 hover:text-white transition-colors">
              <MapPin className="w-4 h-4 text-[#FF9933]" />
              <span>{profile?.city ? `${profile.city}, ${profile.state}` : 'Mumbai, MH'}</span>
            </button>

            {!loading && (
              <>
                {user ? (
                  <>
                    {/* Wallet Button + Dropdown */}
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

                    {/* Notifications Button + Dropdown */}
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
                            <p className="text-sm font-bold text-white truncate">{profile?.full_name ?? 'Rajesh Kumar'}</p>
                            <p className="text-xs text-gray-400 truncate mt-0.5">{user.email ?? 'rajesh@example.com'}</p>
                          </div>
                          <div className="py-1.5">
                            <Link href="/profile" onClick={closeAll} className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-[#252525] hover:text-white transition-colors">
                              <User className="w-4 h-4 text-gray-500" /> Profile
                            </Link>
                            <Link href="/bookings" onClick={closeAll} className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-[#252525] hover:text-white transition-colors">
                              <BookOpen className="w-4 h-4 text-gray-500" /> My Bookings
                            </Link>
                            <Link href="/profile" onClick={closeAll} className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-[#252525] hover:text-white transition-colors">
                              <Heart className="w-4 h-4 text-gray-500" /> Favorites
                            </Link>
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
                ) : (
                  <div className="flex items-center gap-2">
                    <Link
                      href="/auth/signin"
                      className="text-sm font-medium text-gray-300 hover:text-white transition-colors px-3 py-1.5"
                    >
                      Sign In
                    </Link>
                    <Link
                      href="/auth/signup"
                      className="text-sm font-semibold bg-[#FF9933] hover:bg-[#e8872e] text-white px-4 py-1.5 rounded-lg transition-all duration-200 hover:shadow-lg hover:shadow-[#FF9933]/20"
                    >
                      Get Started
                    </Link>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Mobile menu button */}
          <button
            className="md:hidden p-2 rounded-lg text-gray-300 hover:text-white transition-colors"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {menuOpen && (
        <div className="md:hidden bg-[#0d0d0d] border-t border-[#2a2a2a]">
          <div className="px-4 py-4 space-y-2">
            {navLinks.map((link) => (
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
            <div className="pt-2 border-t border-[#2a2a2a]">
              {user ? (
                <div className="space-y-2">
                  <Link href="/profile" className="block px-4 py-3 rounded-lg text-sm text-gray-300 hover:bg-[#1e1e1e] hover:text-white">Profile</Link>
                  <Link href="/bookings" className="block px-4 py-3 rounded-lg text-sm text-gray-300 hover:bg-[#1e1e1e] hover:text-white">My Bookings</Link>
                  <Link href="/wallet" className="block px-4 py-3 rounded-lg text-sm text-gray-300 hover:bg-[#1e1e1e] hover:text-white">Wallet</Link>
                  <button onClick={handleSignOut} className="block w-full text-left px-4 py-3 rounded-lg text-sm text-red-400 hover:bg-red-900/20">Sign out</button>
                </div>
              ) : (
                <div className="flex gap-3">
                  <Link href="/auth/signin" className="flex-1 text-center px-4 py-3 rounded-lg text-sm font-medium text-gray-300 border border-[#2a2a2a] hover:border-[#FF9933]/50">Sign In</Link>
                  <Link href="/auth/signup" className="flex-1 text-center px-4 py-3 rounded-lg text-sm font-semibold bg-[#FF9933] text-white hover:bg-[#e8872e]">Get Started</Link>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
