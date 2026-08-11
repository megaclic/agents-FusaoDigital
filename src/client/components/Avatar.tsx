import { useState } from "react";
import { cn } from "@/client/lib/utils";

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

// Contact/persona avatar: the photo when one resolved (proxied through our origin — see
// docs/ui.md/getConversationAvatar — direct external image URLs are blocked by img-src CSP), a
// fallback to initials otherwise (missing src, or the image failed to load — a dead/expired
// external URL degrades silently to initials instead of a broken-image icon).
export function Avatar({ name, src, size = "md", className }: AvatarProps) {
  const [errored, setErrored] = useState(false);
  const showImage = !!src && !errored;
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
          src={src}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setErrored(true)}
          loading="lazy"
        />
      ) : (
        initialsFor(name)
      )}
    </div>
  );
}
