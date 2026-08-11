import { describe, expect, test } from "bun:test";
import { extractZproCredentialsFromUrl } from "@/client/lib/zpro";

describe("extractZproCredentialsFromUrl", () => {
  test("extracts origin + apiId from the full URL pasted from the Z-PRO panel", () => {
    expect(
      extractZproCredentialsFromUrl(
        "https://api.fusaobotcrm.com.br/v2/api/external/b4c2ae0c-bb48-41fa-9c28-7812d4797775",
      ),
    ).toEqual({
      baseUrl: "https://api.fusaobotcrm.com.br",
      apiId: "b4c2ae0c-bb48-41fa-9c28-7812d4797775",
    });
  });

  test("ignores a trailing path segment after the apiId", () => {
    expect(
      extractZproCredentialsFromUrl(
        "https://api.fusaobotcrm.com.br/v2/api/external/abc123/listChannels",
      ),
    ).toEqual({
      baseUrl: "https://api.fusaobotcrm.com.br",
      apiId: "abc123",
    });
  });

  test("trims surrounding whitespace from a pasted value", () => {
    expect(
      extractZproCredentialsFromUrl(
        "  https://api.fusaobotcrm.com.br/v2/api/external/abc123  ",
      ),
    ).toEqual({ baseUrl: "https://api.fusaobotcrm.com.br", apiId: "abc123" });
  });

  test("returns null for a bare origin (no ApiID in the path)", () => {
    expect(
      extractZproCredentialsFromUrl("https://api.fusaobotcrm.com.br"),
    ).toBeNull();
  });

  test("returns null for an invalid URL", () => {
    expect(extractZproCredentialsFromUrl("not a url")).toBeNull();
    expect(extractZproCredentialsFromUrl("")).toBeNull();
  });
});
