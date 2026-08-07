import { describe, expect, test } from "bun:test";
import { translateWithLocale } from "@/api/lib/i18n";

// NOTE: the AppError → onError localization seam: translationKey + translationParams resolve
// to a localized, interpolated message (the exact call `onError` makes).
describe("translateWithLocale", () => {
  test("interpolates params into the localized entry (both locales)", () => {
    const params = { len: 120_000, max: 100_000 };
    const pt = translateWithLocale(
      "pt-BR",
      "errors.promptTooLong",
      "fallback",
      params,
    );
    expect(pt).toBe(
      "O prompt do sistema é longo demais: 120000 caracteres (limite 100000).",
    );
    const en = translateWithLocale(
      "en",
      "errors.promptTooLong",
      "fallback",
      params,
    );
    expect(en).toBe(
      "System prompt is too long: 120000 characters (limit 100000).",
    );
  });

  test("unknown key falls back to the provided default", () => {
    expect(translateWithLocale("pt-BR", "errors.__nope__", "the default")).toBe(
      "the default",
    );
  });
});
