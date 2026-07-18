'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Send } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase, type Message } from '@/lib/supabase';
import { toast } from 'sonner';

function formatStamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
}

export default function BookingChat({ bookingId }: { bookingId: string }) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  // Append unless we already have this id (realtime can echo a row we just fetched).
  const addMessage = useCallback((m: Message) => {
    setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
  }, []);

  // Initial fetch + realtime subscription. RLS gates both the fetch and the live stream,
  // so only the two booking parties ever see these rows.
  useEffect(() => {
    let active = true;

    (async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('booking_id', bookingId)
        .order('created_at');
      if (!active) return;
      if (error) {
        console.error('Failed to load messages:', error.message);
      } else {
        setMessages((data ?? []) as Message[]);
      }
      setLoading(false);
    })();

    const channel = supabase
      .channel(`messages:${bookingId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `booking_id=eq.${bookingId}` },
        (payload) => addMessage(payload.new as Message),
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [bookingId, addMessage]);

  // Keep the newest message in view by scrolling the thread itself. scrollIntoView() would
  // also scroll every ancestor, dragging the whole page down to the chat on load — which
  // would bury the booking's action buttons above it.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const text = body.trim();
    if (!text || !user || sending) return;
    setSending(true);
    // No optimistic append — the realtime echo delivers our own row (dedup guard prevents doubles).
    const { error } = await supabase
      .from('messages')
      .insert({ booking_id: bookingId, sender_id: user.id, body: text });
    setSending(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setBody('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col bg-[#161616] border border-[#2a2a2a] rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-[#222]">
        <h2 className="font-bold text-white">Chat</h2>
        <p className="text-xs text-gray-500 mt-0.5">Messages are part of this booking&apos;s record and can&apos;t be edited or deleted.</p>
      </div>

      {/* Thread */}
      <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3 min-h-[240px] max-h-[55vh]">
        {loading ? (
          <p className="text-center text-sm text-gray-500 py-8">Loading messages…</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-sm text-gray-500 py-8">No messages yet. Say hello 👋</p>
        ) : (
          messages.map((m) => {
            const mine = m.sender_id === user?.id;
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                    mine
                      ? 'bg-[#FF9933] text-white rounded-br-sm'
                      : 'bg-[#1e1e1e] border border-[#2a2a2a] text-gray-100 rounded-bl-sm'
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p className={`text-[10px] mt-1 ${mine ? 'text-white/70' : 'text-gray-500'}`}>{formatStamp(m.created_at)}</p>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Composer */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-[#222]">
        <input
          type="text"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={2000}
          placeholder="Type a message…"
          className="flex-1 bg-[#0d0d0d] border border-[#2a2a2a] rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-[#FF9933]/50"
        />
        <button
          onClick={send}
          disabled={sending || body.trim().length === 0}
          className="saffron-btn flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50"
        >
          <Send className="w-4 h-4" />
          Send
        </button>
      </div>
    </div>
  );
}
