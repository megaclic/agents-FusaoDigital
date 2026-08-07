import { AsyncLocalStorage } from "node:async_hooks";
import { createInstance } from "i18next";
import en from "@/api/locales/en.json";
import ptBR from "@/api/locales/pt-BR.json";

export type Locale = "en" | "pt-BR";

interface RequestContext {
  locale: Locale;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// NOTE: own instance, NOT the i18next singleton — the client bundle inits the singleton with the
// CLIENT locales, and any context where both coexist (bun test workers) would clobber the server
// resources (silently falling back to defaultValue).
const i18n = createInstance();

i18n.init({
  resources: {
    en: { translation: en },
    "pt-BR": { translation: ptBR },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

export function translate(key: string, defaultValue?: string): string {
  const ctx = requestContext.getStore();
  const locale = ctx?.locale ?? "en";
  return translateWithLocale(locale, key, defaultValue);
}

// NOTE: explicit-locale variant for contexts where the request ALS may not be in scope
// (e.g. Elysia's `onError`, which derives the locale straight from the Accept-Language header).
export function translateWithLocale(
  locale: Locale,
  key: string,
  defaultValue?: string,
  params?: Record<string, string | number>,
): string {
  // NOTE: params spread into the options bag — i18next resolves {{placeholders}} from it.
  return i18n.t(key, {
    lng: locale,
    defaultValue: defaultValue ?? key,
    ...params,
  });
}

export function getLocaleFromHeader(acceptLanguage: string | null): Locale {
  if (acceptLanguage?.includes("pt")) {
    return "pt-BR";
  }
  return "en";
}

export default i18n;
