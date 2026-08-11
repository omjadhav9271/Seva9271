'use client';

import { useEffect, useRef, useState } from 'react';
import { MapPin, Navigation, Loader2, X, Crosshair, AlertTriangle } from 'lucide-react';
import {
  accuracyVerdict, fetchPincodeAnchors, isPincode, requestBrowserLocation, resolvePincode,
  type AccuracyVerdict, type PincodeAnchor, type SearchOrigin,
} from '@/lib/matching';

/* Where the customer is searching FROM — one control, shared by /services and /providers.

   ── GPS IS THE PRIMARY ACTION, AND THE LAYOUT HAS TO SAY SO ─────────────────────────────────
   The previous version put a wide pincode field on the left and a modest button beside it, which
   in reading order and visual weight said "type a pincode; there is also a location thing". That
   is the opposite of what we want: a device fix is typically 100-200 m where a pincode is a 2-5 km
   locality, so GPS finds genuinely nearer people. The button is now the full-width primary CTA
   with the benefit stated on it; the pincode sits underneath as the clearly-secondary path.

   🔴 THE PINCODE IS NOT HIDDEN BEHIND A TOGGLE, deliberately. Collapsing it would add a click for
   exactly the people who cannot use GPS — desktop users, anyone who has denied the permission,
   anyone on a locked-down device — and the honest-signposting principle says show the alternative
   and let the hierarchy do the persuading. Preference, not coercion.

   ── AND THE PREFERENCE IS EARNED, NOT ASSERTED ──────────────────────────────────────────────
   `coords.accuracy` decides whether GPS actually beat a pincode on THIS device, and we say so
   afterwards: "accurate to ±124 m" when it worked, and a plain admission plus a pincode nudge when
   the device could only manage ±30 km. Claiming GPS is best while silently ranking from a bad fix
   is how you lose the customer's trust in the default. Telling them when it went wrong is how you
   keep it.

   ── ON NOT AUTO-PROMPTING ───────────────────────────────────────────────────────────────────
   The permission is still requested on an explicit click, never on page load. In Chrome a DENIED
   permission is sticky per-origin: a prompt fired before the visitor knows what the page is for is
   the one people reflexively dismiss, and that dismissal costs GPS for that site more or less
   permanently. You get one ask; spend it after they have seen what it is for. A browser that has
   ALREADY granted permission is prefilled silently — the best case, zero friction. */

export default function SearchLocation({ origin, onOrigin, autoLocate = true }: {
  origin: SearchOrigin | null;
  onOrigin: (next: SearchOrigin | null) => void;
  /** False when the page already has an explicit location intent — e.g. it arrived with ?city=.
   *  A prefill must never overrule a choice the customer already made. */
  autoLocate?: boolean;
}) {
  const [typed, setTyped] = useState('');
  const [locating, setLocating] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<AccuracyVerdict | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [suggestions, setSuggestions] = useState<PincodeAnchor[]>([]);
  const prefilled = useRef(false);
  /* A live mirror of the origin prop, readable from inside the async prefill AFTER its awaits.
     The closure's `origin` is the value at effect time and is therefore always stale by then —
     which is how the prefill once overwrote a ?city= choice made while it was in flight. */
  const originRef = useRef(origin);
  originRef.current = origin;

  // Read the permission WITHOUT asking. A blocked site should say so and point at the browser
  // control, rather than offering a button that silently fails every time it is pressed.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
        if (alive && status) setBlocked(status.state === 'denied');
      } catch { /* Safari has no permissions API for geolocation — assume askable */ }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (prefilled.current || origin || !autoLocate) return;
    prefilled.current = true;
    (async () => {
      try {
        const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
        if (status?.state !== 'granted') return;      // never prompt from here
      } catch { return; }
      const pos = await requestBrowserLocation();
      if ('error' in pos) return;                      // silent: they never asked for this
      if (originRef.current) return;                   // a real choice landed while we waited
      setVerdict(accuracyVerdict(pos.accuracyM));
      onOrigin({ lat: pos.lat, lng: pos.lng, label: 'your location' });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, autoLocate]);

  const useMyLocation = async () => {
    setLocating(true);
    setNote(null);
    setSuggestions([]);
    const pos = await requestBrowserLocation();
    setLocating(false);
    if ('error' in pos) {
      setNote(pos.error);
      setVerdict(null);
      try {
        const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
        setBlocked(status?.state === 'denied');
      } catch { /* ignore */ }
      return;
    }
    setTyped('');
    const v = accuracyVerdict(pos.accuracyM);
    setVerdict(v);
    // A poor fix is reported, not buried — the pincode is the better tool at that point.
    setNote(v.nudge);
    onOrigin({ lat: pos.lat, lng: pos.lng, label: 'your location' });
  };

  const applyTyped = async () => {
    const value = typed.trim();
    if (!value || resolving) return;
    if (!isPincode(value)) {
      setNote('Enter a 6-digit pincode, or use your location above.');
      return;
    }
    setResolving(true);
    setNote(null);
    setSuggestions([]);
    const hit = await resolvePincode(value);
    setResolving(false);
    if (!hit) {
      setNote(`We don't have providers around ${value} yet.`);
      setSuggestions((await fetchPincodeAnchors()).slice(0, 5));
      return;
    }
    setVerdict(null);   // a pincode has no device accuracy to report
    if (hit.granularity === 'district') {
      setNote(`We don't have enough providers in ${value} itself yet — searching from the wider ${value.slice(0, 3)} area.`);
    }
    onOrigin({ lat: hit.lat, lng: hit.lng, label: hit.label });
  };

  const useSuggestion = (a: PincodeAnchor) => {
    setTyped(a.pincode);
    setNote(null);
    setSuggestions([]);
    setVerdict(null);
    onOrigin({ lat: a.lat, lng: a.lng, label: `${a.pincode} · ${a.city}` });
  };

  const toneClass = verdict?.tone === 'good' ? 'text-[#22c55e]'
    : verdict?.tone === 'poor' ? 'text-amber-400' : 'text-gray-400';

  return (
    <div className="w-full">
      {/* PRIMARY: the device fix. Full width, filled, benefit on the label. */}
      <button
        type="button"
        onClick={useMyLocation}
        disabled={locating}
        className="w-full flex items-center justify-center gap-2.5 rounded-xl px-4 py-3.5 text-sm font-semibold
                   bg-[#FF9933] text-white hover:bg-[#e8872e] transition-colors disabled:opacity-60
                   shadow-lg shadow-[#FF9933]/20"
      >
        {locating
          ? <><Loader2 className="w-4 h-4 animate-spin" />Finding you…</>
          : <><Navigation className="w-4 h-4" />Use my location<span className="font-normal text-white/80 hidden sm:inline">— finds people nearest you</span></>}
      </button>

      {blocked && (
        <p className="text-xs text-amber-400/90 mt-2 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          Location is blocked for this site. Allow it from the padlock in your browser bar, or use a
          pincode below.
        </p>
      )}

      {/* SECOND, not shrunken. GPS wins on ORDER and on the filled primary style — that is enough
          to express the preference. Making the fallback tiny as well would punish the people who
          land on it (desktop, denied permission, locked-down device) for a choice they did not
          get to make. Same size and shape as any other field on the page. */}
      <div className="flex items-center gap-3 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 mt-3
                      focus-within:border-[#FF9933]/60 transition-colors">
        <MapPin className="w-5 h-5 text-gray-500 flex-shrink-0" />
        <input
          type="text"
          inputMode="numeric"
          maxLength={6}
          aria-label="Search location"
          placeholder="Or enter your pincode — e.g. 400050"
          value={typed}
          onChange={(e) => setTyped(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void applyTyped(); } }}
          onBlur={() => { void applyTyped(); }}
          className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
        />
        {resolving && <Loader2 className="w-4 h-4 animate-spin text-gray-500" />}
      </div>

      {/* What is in effect — and, for a device fix, HOW GOOD IT WAS. Saying "±124 m" is what turns
          "we prefer GPS" from a claim into something the customer can see. */}
      {origin && (
        <p className="text-xs text-gray-400 mt-3 flex items-center gap-1.5 flex-wrap">
          <Crosshair className="w-3.5 h-3.5 text-[#FF9933]" />
          Searching near <span className="text-white font-medium">{origin.label}</span>
          {verdict && <span className={toneClass}>· {verdict.label}</span>}
          <button
            type="button"
            onClick={() => { setTyped(''); setNote(null); setVerdict(null); setSuggestions([]); onOrigin(null); }}
            className="inline-flex items-center gap-1 text-gray-500 hover:text-white transition-colors"
          >
            <X className="w-3 h-3" />clear
          </button>
        </p>
      )}

      {note && (
        <p className="text-xs text-gray-400 mt-2 flex items-center gap-1.5">
          <MapPin className="w-3.5 h-3.5 text-gray-500" />{note}
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">We do cover:</span>
          {suggestions.map((a) => (
            <button
              key={a.pincode}
              type="button"
              onClick={() => useSuggestion(a)}
              className="text-xs px-2.5 py-1 rounded-full bg-[#1a1a1a] border border-[#2a2a2a] text-gray-300 hover:border-[#FF9933] hover:text-white transition-colors"
            >
              {a.pincode} · {a.city} ({a.provider_count})
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
