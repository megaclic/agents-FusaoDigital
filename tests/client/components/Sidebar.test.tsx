/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

const mockUser = { role: "AGENT" as string };

mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mockUser }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module("@/client/contexts/ThemeContext", () => ({
  useThemedAsset: (path: string) => ({ src: path }),
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: () => {},
  }),
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));

// SUPPORT_LINK.defaultEmail is intentionally "" (Sidebar.tsx renders no support block until the
// operator configures a real address via Admin > Identidade Visual) — without a supportEmail the
// footer's support button doesn't render at all, so the two tests below need one mocked in.
mock.module("@/client/contexts/BrandingContext", () => ({
  useBranding: () => ({
    config: { supportEmail: "suporte@fazer.ai" },
    logoUrl: null,
    brandName: "fazer.ai",
    ready: true,
    refresh: async () => {},
  }),
  BrandingProvider: ({ children }: { children: ReactNode }) => children,
}));

import { Sidebar } from "@/client/components/Sidebar";
import { SidebarProvider, useSidebar } from "@/client/contexts/SidebarContext";

let hook: ReturnType<typeof useSidebar> | null = null;
function Probe() {
  hook = useSidebar();
  return null;
}

function renderSidebar(initialPath = "/") {
  return render(
    <TooltipPrimitive.Provider>
      <MemoryRouter initialEntries={[initialPath]}>
        <SidebarProvider>
          <Probe />
          <Sidebar />
        </SidebarProvider>
      </MemoryRouter>
    </TooltipPrimitive.Provider>,
  );
}

describe("Sidebar", () => {
  beforeEach(() => {
    localStorage.clear();
    mockUser.role = "AGENT";
    hook = null;
  });

  afterEach(() => {
    cleanup();
  });

  test("renders Conversations link for regular users", () => {
    renderSidebar();
    // Exact match, not a substring regex: the Z-PRO nav item ("Z-PRO conversations") also
    // contains "conversations", so a loose /conversations/i match hits both and getByRole throws
    // on multiple matches.
    expect(
      screen.getByRole("link", { name: "Conversations" }),
    ).toBeInTheDocument();
  });

  test("hides Admin link for non-admin users", () => {
    renderSidebar();
    expect(screen.queryByRole("link", { name: /admin/i })).toBeNull();
  });

  test("shows Admin link for ADMIN role", () => {
    mockUser.role = "TENANT_ADMIN";
    renderSidebar();
    expect(screen.getByRole("link", { name: /admin/i })).toBeInTheDocument();
  });

  test("marks current route with aria-current=page", () => {
    mockUser.role = "TENANT_ADMIN";
    renderSidebar("/admin");
    const adminLink = screen.getByRole("link", { name: /admin/i });
    expect(adminLink).toHaveAttribute("aria-current", "page");
  });

  test("has collapse/expand toggle button", () => {
    renderSidebar();
    const toggles = screen.getAllByRole("button", { name: /collapse|expand/i });
    expect(toggles.length).toBeGreaterThanOrEqual(1);
  });

  describe("footer", () => {
    test("renders support button (opens modal, not a link)", () => {
      renderSidebar();
      const btn = screen.getByRole("button", { name: /^support$/i });
      expect(btn.tagName).toBe("BUTTON");
    });

    test("renders secondary links with target=_blank and rel=noopener", () => {
      renderSidebar();
      const github = screen.getByRole("link", { name: /github/i });
      expect(github).toHaveAttribute("target", "_blank");
      expect(github).toHaveAttribute("rel", "noopener noreferrer");
      expect(github.getAttribute("href")).toMatch(/^https:\/\//);
    });

    test("clicking support button opens a dialog with the email", () => {
      renderSidebar();
      const btn = screen.getByRole("button", { name: /^support$/i });
      act(() => {
        fireEvent.click(btn);
      });
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      // The mailto anchor inside the dialog carries the support email.
      const mailto = screen
        .getAllByRole("link")
        .find((a) => a.getAttribute("href")?.startsWith("mailto:"));
      expect(mailto?.getAttribute("href")).toMatch(/^mailto:.+@.+/);
    });
  });

  describe("mobile drawer", () => {
    test("is not mounted when mobileOpen is false", () => {
      renderSidebar();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    test("mounts a dialog when mobileOpen becomes true", () => {
      renderSidebar();
      act(() => {
        hook?.setMobileOpen(true);
      });
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    test("exposes close button with accessible name", () => {
      renderSidebar();
      act(() => {
        hook?.setMobileOpen(true);
      });
      expect(
        screen.getByRole("button", { name: /close menu/i }),
      ).toBeInTheDocument();
    });

    test("logo link inside drawer closes the drawer on click", () => {
      renderSidebar();
      act(() => {
        hook?.setMobileOpen(true);
      });
      const dialog = screen.getByRole("dialog");
      const logoLink = dialog.querySelector("a[href]") as HTMLAnchorElement;
      expect(logoLink).not.toBeNull();
      act(() => {
        fireEvent.click(logoLink);
      });
      expect(hook?.mobileOpen).toBe(false);
    });

    test("clicking a nav link closes the drawer", () => {
      mockUser.role = "TENANT_ADMIN";
      renderSidebar();
      act(() => {
        hook?.setMobileOpen(true);
      });
      const dialog = screen.getByRole("dialog");
      const navLinks = dialog.querySelectorAll("nav a");
      const navLink = Array.from(navLinks).find((a) =>
        /conversations/i.test(a.textContent ?? ""),
      ) as HTMLAnchorElement;
      expect(navLink).toBeTruthy();
      act(() => {
        fireEvent.click(navLink);
      });
      expect(hook?.mobileOpen).toBe(false);
    });
  });
});
