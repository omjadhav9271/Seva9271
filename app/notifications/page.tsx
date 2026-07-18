'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Bell, CheckCircle, Info, AlertTriangle, AlertCircle, CheckCheck, type LucideIcon } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase, type Notification } from '@/lib/supabase';

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

export default function NotificationsPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    let active = true;
    (async () => {
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (!active) return;
      if (data) setNotifications(data as Notification[]);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [user, authLoading]);

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  const markAllRead = useCallback(async () => {
    if (!user || unreadCount === 0) return;
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', user.id)
      .eq('is_read', false);
  }, [user, unreadCount]);

  const openNotification = (n: Notification) => {
    if (!n.is_read) {
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
      supabase.from('notifications').update({ is_read: true }).eq('id', n.id);
    }
    if (n.link) router.push(n.link);
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 text-center text-gray-400">Loading…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-20 text-center">
          <Bell className="w-12 h-12 text-gray-600 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-white mb-2">Sign in to see your notifications</h1>
          <Link href="/auth/signin" className="text-[#FF9933] text-sm hover:text-[#e8872e]">Go to Sign In →</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-black text-white">Notifications</h1>
            <p className="text-sm text-gray-400 mt-0.5">
              {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
            </p>
          </div>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="flex items-center gap-1.5 text-sm font-medium text-[#FF9933] hover:text-[#e8872e] transition-colors"
            >
              <CheckCheck className="w-4 h-4" /> Mark all read
            </button>
          )}
        </div>

        {notifications.length === 0 ? (
          <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl py-20 text-center">
            <Bell className="w-12 h-12 text-gray-600 mx-auto mb-4" />
            <p className="text-gray-400 text-sm">No notifications yet</p>
          </div>
        ) : (
          <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl overflow-hidden divide-y divide-[#222]">
            {notifications.map((n) => {
              const { icon: Icon, color } = notifStyles[n.type] ?? notifStyles.info;
              const clickable = Boolean(n.link);
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => openNotification(n)}
                  disabled={!clickable}
                  className={`w-full text-left flex items-start gap-3 px-5 py-4 transition-colors ${
                    clickable ? 'hover:bg-[#252525] cursor-pointer' : 'cursor-default'
                  } ${n.is_read ? '' : 'bg-[#FF9933]/[0.04]'}`}
                >
                  <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: `${color}20` }}>
                    <Icon className="w-4 h-4" style={{ color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-white">{n.title}</p>
                      {!n.is_read && <span className="w-2 h-2 rounded-full bg-[#FF9933] flex-shrink-0" />}
                    </div>
                    <p className="text-sm text-gray-400 mt-0.5 leading-relaxed">{n.message}</p>
                    <p className="text-[11px] text-gray-600 mt-1">{timeAgo(n.created_at)}</p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
