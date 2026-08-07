import {
  Bot,
  Gauge,
  Globe,
  KeyRound,
  LibraryBig,
  LifeBuoy,
  MessageSquare,
  MessagesSquare,
  RadioTower,
  ScrollText,
  Settings,
  Shield,
  Webhook,
} from "lucide-react";
import type { ElementType, SVGProps } from "react";
import { GithubIcon } from "@/client/components/icons/GithubIcon";
import { isAdminRole } from "@/client/lib/roles";

// NOTE: ElementType (not ComponentType) so it fits lucide's ForwardRefExotic
// components, inline React icons, and `<img>`-based brand marks without
// per-item casts.
export type NavItemIcon = ElementType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export interface NavItem {
  to: string;
  labelKey: string;
  defaultLabel: string;
  icon: NavItemIcon;
  // NOTE: bump to requiredRole if more roles are added
  requireAdmin?: boolean;
  // Optional count badge driven by a named source. "approvals" => pending KB suggestions
  // (usePendingApprovals). The sidebar renders a numeric pill (expanded) or a dot (collapsed).
  badge?: "approvals";
}

// t('nav.dashboard', 'Dashboard')
// t('nav.conversations', 'Conversations')
// t('nav.zproConversations', 'Z-PRO conversations')
// t('nav.agents', 'Agents')
// t('nav.resources', 'Components')
// t('nav.channels', 'Channels')
// t('nav.webhooks', 'Webhooks')
// t('nav.apiKeys', 'API keys')
// t('nav.logs', 'Logs')
// t('nav.admin', 'Admin')
// t('nav.settings', 'Settings')
export const NAV_ITEMS: NavItem[] = [
  {
    to: "/",
    labelKey: "nav.dashboard",
    defaultLabel: "Dashboard",
    icon: Gauge,
    requireAdmin: true,
  },
  {
    to: "/conversations",
    labelKey: "nav.conversations",
    defaultLabel: "Conversations",
    icon: MessagesSquare,
  },
  {
    to: "/zpro/conversations",
    labelKey: "nav.zproConversations",
    defaultLabel: "Z-PRO conversations",
    icon: MessageSquare,
  },
  {
    to: "/agents",
    labelKey: "nav.agents",
    defaultLabel: "Agents",
    icon: Bot,
    requireAdmin: true,
  },
  {
    to: "/resources",
    labelKey: "nav.resources",
    defaultLabel: "Components",
    icon: LibraryBig,
    requireAdmin: true,
    badge: "approvals",
  },
  {
    to: "/channels",
    labelKey: "nav.channels",
    defaultLabel: "Channels",
    icon: RadioTower,
    requireAdmin: true,
  },
  {
    to: "/webhooks",
    labelKey: "nav.webhooks",
    defaultLabel: "Webhooks",
    icon: Webhook,
    requireAdmin: true,
  },
  {
    to: "/api-keys",
    labelKey: "nav.apiKeys",
    defaultLabel: "API keys",
    icon: KeyRound,
    requireAdmin: true,
  },
  {
    to: "/logs",
    labelKey: "nav.logs",
    defaultLabel: "Logs",
    icon: ScrollText,
    requireAdmin: true,
  },
  {
    to: "/admin",
    labelKey: "nav.admin",
    defaultLabel: "Admin",
    icon: Shield,
    requireAdmin: true,
  },
  {
    to: "/settings",
    labelKey: "nav.settings",
    defaultLabel: "Settings",
    icon: Settings,
  },
];

export function filterNavItems(
  items: NavItem[],
  role: string | undefined,
): NavItem[] {
  return items.filter((item) => !item.requireAdmin || isAdminRole(role));
}

export interface FooterLink {
  // Stable identity so the sidebar can white-label per entry (swap the website
  // href/label from the branding config; hide the GitHub entry).
  id: "website" | "github";
  href: string;
  labelKey: string;
  defaultLabel: string;
  icon: ElementType<SVGProps<SVGSVGElement>>;
}

export interface SupportContact {
  emailKey: string;
  defaultEmail: string;
  labelKey: string;
  defaultLabel: string;
  icon: ElementType<SVGProps<SVGSVGElement>>;
}

// NOTE: SUPPORT_LINK renders above SECONDARY_LINKS with a "Need help?" label
// and opens a modal with the email + copy-to-clipboard action (instead of
// a raw mailto: link, which is unreliable when the user has no mail client).
// The email itself is i18n-driven so projects can route support to a
// locale-specific inbox. Set to null to hide the support block entirely.
// Deliberately no default value exposed here: an empty database must never leak anyone's support
// inbox. The operator configures the real address via Admin > Identidade Visual; until then the
// Sidebar renders no support block (see supportEmail resolution in Sidebar.tsx).
// t('nav.support', 'Support')
// t('support.email', '')
export const SUPPORT_LINK: SupportContact | null = {
  emailKey: "support.email",
  defaultEmail: "",
  labelKey: "nav.support",
  defaultLabel: "Support",
  icon: LifeBuoy,
};

// t('nav.website', '')
// t('nav.github', 'GitHub')
// Fallback GitHub link when the operator hasn't configured a custom repoUrl in branding (see
// customRepoUrl in Sidebar.tsx). Also used for the "new version" upgrade link.
export const AGENTS_REPO_URL =
  "https://github.com/megaclic/agents-FusaoDigital";

export const SECONDARY_LINKS: FooterLink[] = [
  {
    id: "website",
    href: "",
    labelKey: "nav.website",
    defaultLabel: "",
    icon: Globe,
  },
  {
    id: "github",
    href: AGENTS_REPO_URL,
    labelKey: "nav.github",
    defaultLabel: "GitHub",
    icon: GithubIcon,
  },
];

// Upgrade destination for Pro-gated features. Empty: no upsell hub is wired into this fork (kept
// as an exported constant so any dormant <ProGate> import doesn't break).
export const UPGRADE_URL = "";
