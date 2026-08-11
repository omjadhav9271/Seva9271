'use client';

import { useEffect, useRef, useState } from 'react';
import { MapPin, Navigation, Loader2, X } from 'lucide-react';
import {
  fetchPincodeAnchors, isPincode, requestBrowserLocation, resolvePincode,
  type PincodeAnchor, type SearchOrigin,
} from '@/lib/matching';

/* Where the customer is searching FROM — one control, shared by /services and /providers so the
   two pages cannot drift apart again.

   Three rules shape this:

   1. GPS PREFILLS, IT DOES NOT LOCK. People search for places they are not standing in — a
      parent's flat, an office, the house they are about to move into. So the device position is a
      starting point shown in an editable field, never a "home" the page decides for them. It is
      also only read WITHOUT PROMPTING when permission was already granted; a location prompt fired
      at page load is a demand made before the visitor knows what the page is for.

   2. A PINCODE, NOT A CITY. The city dropdown is gone. In India a city is not a location —
      Greater Mumbai is ~12 million people across 60 km, so "Mumbai" ranks a Borivali customer from
      ~17 km away — and the list becomes unusable the moment we serve more than a handful of them.
      A pincode is a locality, it is the thing people know about themselves, and it is one field.

   3. AN UNSERVED PINCODE GETS SUGGESTIONS, NOT A DEAD END. When resolve_pincode() finds nothing we
      show a few areas where we genuinely have providers. That is a short list of places that work,
      which is a different thing from a dropdown of every city we might one day cover. */

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
  const [suggestions, setSuggestions] = useState<PincodeAnchor[]>([]);
  // Prefill runs once, and only when we already have permission. A ref, not state, so it can
  // never re-trigger a search — this page has been round-tripped by a re-render loop before.
  const prefilled = useRef(false);
  /* A live mirror of the origin prop, readable from inside the async prefill AFTER its awaits.
     The closure's `origin` is the value at effect time and is therefore always stale by then —
     which is exactly how the prefill managed to overwrite a choice made while it was in flight. */
  const originRef = useRef(origin);
  originRef.current = origin;

  useEffect(() => {
    if (prefilled.current || origin || !autoLocate) return;
    prefilled.current = true;
    (async () => {
      try {
        // Safari has no permissions API for geolocation; absence just means "don't prefill".
        const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
        if (status?.state !== 'granted') return;
      } catch { return; }
      const pos = await requestBrowserLocation();
      if ('error' in pos) return;   // silent: they never asked for this, so don't report it
      /* Two awaits have passed. If anything set a location while we were waiting — a ?city= param,
         or the customer typing a pincode — that is a deliberate choice and this passive prefill
         must not overwrite it. */
      if (originRef.current) return;
      onOrigin({ ...pos, label: 'your location' });
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
      // Declined or unavailable is never a dead end — the pincode box still works.
      setNote(pos.error.replace('pick your city', 'enter your pincode').replace('Pick your city', 'Enter your pincode'));
      return;
    }
    setTyped('');
    onOrigin({ ...pos, label: 'your location' });
  };

  const applyTyped = async () => {
    const value = typed.trim();
    if (!value || resolving) return;
    if (!isPincode(value)) {
      setNote('Enter a 6-digit pincode — it is the quickest way to find people near you.');
      return;
    }

    setResolving(true);
    setNote(null);
    setSuggestions([]);
    const hit = await resolvePincode(value);
    setResolving(false);

    if (!hit) {
      /* Honest: we have nobody around that pincode. Offer real coverage rather than a shrug —
         and rather than silently ranking them from somewhere they did not ask for. */
      setNote(`We don't have providers around ${value} yet.`);
      const anchors = await fetchPincodeAnchors();
      setSuggestions(anchors.slice(0, 5));
      return;
    }

    if (hit.granularity === 'district') {
      setNote(`We don't have enough providers in ${value} itself yet — searching from the wider ${value.slice(0, 3)} area.`);
    }
    onOrigin({ lat: hit.lat, lng: hit.lng, label: hit.label });
  };

  const useSuggestion = (a: PincodeAnchor) => {
    setTyped(a.pincode);
    setNote(null);
    setSuggestions([]);
    onOrigin({ lat: a.lat, lng: a.lng, label: `${a.pincode} · ${a.city}` });
  };

  return (
    <div className="w-full">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1 flex items-center gap-3 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 focus-within:border-[#FF9933]/60 transition-colors">
          <MapPin className="w-5 h-5 text-gray-500 flex-shrink-0" />
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            aria-label="Search location"
            placeholder="Your pincode — e.g. 400050"
            value={typed}
            onChange={(e) => setTyped(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void applyTyped(); } }}
            onBlur={() => { void applyTyped(); }}
            className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
          />
          {resolving && <Loader2 className="w-4 h-4 animate-spin text-gray-500" />}
        </div>
        <button
          type="button"
          onClick={useMyLocation}
          disabled={locating}
          className="flex items-center justify-center gap-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 text-sm text-white hover:border-[#FF9933] transition-colors disabled:opacity-60"
        >
          {locating
            ? <><Loader2 className="w-4 h-4 animate-spin" />Finding you…</>
            : <><Navigation className="w-4 h-4 text-[#FF9933]" />Use my location</>}
        </button>
      </div>

      {/* What is actually in effect, and how to change it. The customer should never have to guess
          which input won. */}
      {origin && (
        <p className="text-xs text-gray-400 mt-3 flex items-center gap-1.5 flex-wrap">
          <MapPin className="w-3.5 h-3.5 text-[#FF9933]" />
          Searching near <span className="text-white font-medium">{origin.label}</span>
          <button
            type="button"
            onClick={() => { setTyped(''); setNote(null); setSuggestions([]); onOrigin(null); }}
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
