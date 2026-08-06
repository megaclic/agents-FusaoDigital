import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import { doc, errors } from "@/api/lib/openapi";
import { getUpdates } from "@/modules/updates/service";

// Operator-facing announcements + the "new version available" check, proxied and cached from the
// configured hub (see src/modules/updates; empty/unset URL disables it, the default in this fork).
// Authenticated but NOT tenant-scoped: the payload is global to the deployment, so any logged-in
// operator gets the same result. Fail-open — an unreachable or disabled hub yields an empty
// payload, never an error.
export const updatesController = new Elysia({
  prefix: "/updates",
  tags: ["System"],
})
  .use(authPlugin)
  .get("/", () => getUpdates(), {
    requireAuth: true,
    // Documents the auth-failure path (the only status this fail-open endpoint returns besides 200);
    // the codebase declares error statuses only, never an explicit 200 (see api/lib/openapi.ts).
    response: errors(401),
    detail: doc(
      "Operator announcements & update check",
      "Active hub announcements (rendered as a top banner) plus whether a newer app version is available for this edition. Authenticated; global (not tenant-scoped); fail-open (empty when the hub is unreachable or disabled via FAZER_AI_HUB_URL).",
    ),
  });
