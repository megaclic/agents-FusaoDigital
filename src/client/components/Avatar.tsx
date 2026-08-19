import { cn } from "@/client/lib/utils";
import { useMediaObjectUrl } from "./useMediaObjectUrl";

interface AvatarProps {
  name?: string | null;
  src?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE_CLS: Record<NonNullable<AvatarProps["size"]>, string> = {
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-12 w-12 text-base",
};

function initialsFor(name: string | null | undefined): string {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

// Contact/persona avatar: the photo when one resolved, a fallback to initials otherwise (missing
// src, or the image failed to load — a dead/expired external URL degrades silently to initials
// instead of a broken-image icon). `src` is always our own same-origin proxy (CSP's img-src is
// 'self' only — see docs/ui.md/getConversationAvatar), fetched WITH the X-Tenant-Id header via
// useMediaObjectUrl rather than set directly as <img src>: a raw <img> can't carry that header, so
// a SUPER_ADMIN viewing another tenant got a 400 ("A target tenant is required") on every avatar —
// silent before this, because avatarUrl was rarely populated; confirmed live 2026-08-18 once the
// Z-PRO mirror started capturing it from every message instead of only contact-create-update.
export function Avatar({ name, src, size = "md", className }: AvatarProps) {
  const { url, failed } = useMediaObjectUrl(src ?? "");
  const showImage = !!url && !failed;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg-tertiary font-medium text-text-secondary",
        SIZE_CLS[size],
        className,
      )}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={url}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        initialsFor(name)
      )}
    </div>
  );
}
