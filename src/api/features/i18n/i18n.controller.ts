import Elysia, { t } from "elysia";
import i18n from "@/api/lib/i18n";
import { doc, jsonResponse } from "@/api/lib/openapi";

export const i18nController = new Elysia({
  prefix: "/i18n",
  tags: ["System"],
}).get(
  "/locales",
  () => {
    const languages = Object.keys(i18n.options.resources ?? {});
    return { languages };
  },
  {
    detail: {
      ...doc(
        "List available locales",
        "Returns the language codes for which translation resources are loaded.",
      ),
      security: [],
      responses: {
        200: jsonResponse(
          "The loaded locale codes.",
          t.Object({
            languages: t.Array(
              t.String({ description: "Locale code (e.g. pt-BR)." }),
            ),
          }),
        ),
      },
    },
  },
);
