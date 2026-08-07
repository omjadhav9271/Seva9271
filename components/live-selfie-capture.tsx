'use client';

/* Bucket C (14) — the enrollment selfie is CAPTURED, not uploaded.
   A file upload proves the applicant owns a photo of somebody. A live capture proves somebody was
   in front of a camera at the moment they applied. That is the honest step available to us today;
   blink / turn-your-head liveness detection is a vendor feature and is deliberately NOT built here
   (see /docs/Seva-Decisions-Log.md).

   It must never dead-end. A provider on a laptop with no webcam, or who fat-fingered "Block" on
   the permission prompt, still has to be able to finish their application — so every failure path
   names what went wrong, offers a retry, and then offers an upload fallback that is FLAGGED as
   such (meta.capture = 'upload_fallback') so the human reviewer knows this one wasn't live.

   Honest about its own limits: meta.capture is a hint FOR THE REVIEWER, not a security control —
   it is asserted by the client, like any other field a browser sends. The gate is, and remains,
   an admin looking at the photograph. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, Check, Upload, AlertTriangle, Loader2 } from 'lucide-react';

export type CaptureSource = 'live' | 'upload_fallback';

// Cap the long edge: a 4K webcam frame is a 4 MB JPEG for no extra evidentiary value.
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.9;

type Phase = 'idle' | 'starting' | 'live' | 'review' | 'error';

function messageFor(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Camera access was blocked. Click the camera icon in your browser’s address bar, allow access for this site, then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Your camera is already in use by another app. Close it (video calls are the usual culprit) and try again.';
    case 'OverconstrainedError':
      return 'Your camera couldn’t provide a usable picture.';
    default:
      return 'The camera couldn’t be started on this device.';
  }
}

export default function LiveSelfieCapture({
  onPhoto,
  busy = false,
  accept,
}: {
  onPhoto: (file: File, source: CaptureSource) => void | Promise<void>;
  busy?: boolean;
  accept: string;   // mirrors the bucket's allowed mime types, for the fallback input
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<{ url: string; file: File } | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const shotUrlRef = useRef<string | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // Release the camera light and the object URL whatever happens — an unmounted component
  // holding a live MediaStream is how a page ends up with the webcam on in the background.
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (shotUrlRef.current) URL.revokeObjectURL(shotUrlRef.current);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    // getUserMedia is undefined outside a secure context (plain http on a LAN IP, say) — that is
    // a different problem from a denied permission and deserves a different sentence.
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('This browser won’t give a page camera access here. That usually means the site isn’t on a secure (https) connection.');
      setPhase('error');
      return;
    }
    setPhase('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      setPhase('live');
      // The <video> only exists once phase === 'live' has rendered.
      requestAnimationFrame(() => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => { /* autoplay is muted+inline; ignore */ });
      });
    } catch (err) {
      stopStream();
      setError(messageFor(err));
      setPhase('error');
    }
  }, [stopStream]);

  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // The PREVIEW is mirrored (a mirror is what people expect to see of themselves); the saved
    // frame is not, so the reviewer gets the face the right way round.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `selfie-${Date.now()}.jpg`, { type: 'image/jpeg' });
      if (shotUrlRef.current) URL.revokeObjectURL(shotUrlRef.current);
      const url = URL.createObjectURL(blob);
      shotUrlRef.current = url;
      setShot({ url, file });
      setPhase('review');
      stopStream();
    }, 'image/jpeg', JPEG_QUALITY);
  }, [stopStream]);

  const accepted = async () => {
    if (!shot) return;
    await onPhoto(shot.file, 'live');
  };

  const retake = () => {
    if (shotUrlRef.current) URL.revokeObjectURL(shotUrlRef.current);
    shotUrlRef.current = null;
    setShot(null);
    void start();
  };

  // ── the states ─────────────────────────────────────────────────────────────
  if (phase === 'live') {
    return (
      <div className="space-y-2">
        <div className="relative rounded-xl overflow-hidden bg-black aspect-[4/3] max-w-sm">
          <video ref={videoRef} playsInline muted autoPlay
            className="w-full h-full object-cover" style={{ transform: 'scaleX(-1)' }} />
          <div className="absolute inset-0 pointer-events-none border-2 border-[#FF9933]/40 rounded-xl" />
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={capture}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-[#FF9933] text-white font-medium hover:bg-[#e8872e] transition-all">
            <Camera className="w-3.5 h-3.5" /> Take photo
          </button>
          <button type="button" onClick={() => { stopStream(); setPhase('idle'); }}
            className="text-xs px-3 py-2 rounded-lg border border-[#2a2a2a] text-gray-400 hover:text-white transition-all">
            Cancel
          </button>
        </div>
        <p className="text-xs text-gray-600">Face the camera in good light. Nothing is sent until you accept the photo.</p>
      </div>
    );
  }

  if (phase === 'review' && shot) {
    return (
      <div className="space-y-2">
        <div className="rounded-xl overflow-hidden bg-black aspect-[4/3] max-w-sm">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: URL, not an asset */}
          <img src={shot.url} alt="The selfie you just took" className="w-full h-full object-cover" />
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={accepted} disabled={busy}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-[#138808] text-white font-medium hover:bg-[#0f6b06] transition-all disabled:opacity-60">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Use this photo
          </button>
          <button type="button" onClick={retake} disabled={busy}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-[#2a2a2a] text-gray-400 hover:text-white transition-all disabled:opacity-60">
            <RefreshCw className="w-3.5 h-3.5" /> Retake
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-2 rounded-xl border border-orange-500/25 bg-orange-900/10 px-3 py-2.5">
          <AlertTriangle className="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-orange-200/90">{error}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={start} disabled={busy}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-[#FF9933]/10 border border-[#FF9933]/30 text-[#FF9933] hover:bg-[#FF9933]/20 transition-all disabled:opacity-60">
            <RefreshCw className="w-3.5 h-3.5" /> Try the camera again
          </button>
          {/* The fallback appears only AFTER the camera has actually failed — otherwise it is
              just an upload button with extra steps, and nobody would ever use the camera. */}
          <input ref={fileRef} type="file" accept={accept} className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPhoto(f, 'upload_fallback'); }} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-[#2a2a2a] text-gray-400 hover:text-white transition-all disabled:opacity-60">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            Upload a recent photo instead
          </button>
        </div>
        <p className="text-xs text-gray-600">
          An uploaded photo is marked as such for our reviewers, and may take longer to check.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={start} disabled={busy || phase === 'starting'}
        className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-[#FF9933]/10 border border-[#FF9933]/30 text-[#FF9933] hover:bg-[#FF9933]/20 transition-all disabled:opacity-60">
        {phase === 'starting'
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <Camera className="w-3.5 h-3.5" />}
        {phase === 'starting' ? 'Starting camera…' : 'Open camera'}
      </button>
      <p className="text-xs text-gray-600">
        Taken here and now — we don&apos;t accept an uploaded photo. Your browser will ask permission first.
      </p>
    </div>
  );
}
