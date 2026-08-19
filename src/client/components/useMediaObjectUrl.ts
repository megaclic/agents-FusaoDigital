import { useEffect, useState } from "react";
import { mediaFetch } from "@/client/lib/media";

// Resolves a media `src` into a usable object URL. A `blob:` src is already a full in-memory blob and
// is used as-is (its creator owns its lifecycle). Any other src is fetched WITH the tenant header
// (see mediaFetch) and turned into an object URL, revoked on unmount. Shared by MediaAudio/MediaImage
// and the playground file link so every media load carries the SUPER_ADMIN tenant selector and the
// endpoint (no range support) gets the whole blob for playback/seeking.
// An empty src means "no media" (e.g. Avatar's src prop is optional) — resolve to no url/no
// failure rather than firing a doomed fetch("") the retry loop would chew through.
export function useMediaObjectUrl(src: string): {
  url: string | undefined;
  failed: boolean;
} {
  const [url, setUrl] = useState<string | undefined>(
    src.startsWith("blob:") ? src : undefined,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!src) {
      setUrl(undefined);
      setFailed(false);
      return;
    }
    if (src.startsWith("blob:")) {
      setUrl(src);
      setFailed(false);
      return;
    }
    let revoked = false;
    let objectUrl: string | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setUrl(undefined);
    setFailed(false);

    // Media (esp. WhatsApp voice notes/images) can surface in Chatwoot a beat before the file lands
    // in object storage, so the proxy 404s briefly. Retry with exponential backoff before giving up;
    // the skeleton stays up while we retry.
    const DELAYS_MS = [500, 1000, 2000, 4000];
    const attempt = async (i: number) => {
      try {
        const res = await mediaFetch(src);
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (revoked) return;
        if (i < DELAYS_MS.length) {
          retryTimer = setTimeout(() => void attempt(i + 1), DELAYS_MS[i]);
        } else {
          setFailed(true);
        }
      }
    };
    void attempt(0);

    return () => {
      revoked = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  return { url, failed };
}
