import { useBranding } from "@/client/contexts/BrandingContext";

// The auth-page footer: "© {year} {brandName}". The brand name follows the global white-label
// config. Always plain text, never a link — the default name is a generic placeholder (no
// product to point at), and a custom brand shouldn't be linked anywhere without the operator
// explicitly configuring it.
export function BrandFooter() {
  const { brandName } = useBranding();
  const year = new Date().getFullYear();
  return (
    <footer className="mt-12 text-center">
      <p className="text-text-muted text-xs">
        {"© "}
        {year} <span className="text-text-secondary">{brandName}</span>
      </p>
    </footer>
  );
}
