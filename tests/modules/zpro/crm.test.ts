// tests/modules/zpro/crm.test.ts
// Pure unit tests: readZproCrmConfig (settings reader), resolveZproPipelineId (explicit id vs
// auto-detect-the-sole-pipeline), loadZproStages/loadZproTags (defensive parsing + TTL cache), and
// matchZproStage (case-insensitive name match). No network/DB: ZproClient is duck-typed and cast,
// same pattern as tests/modules/zpro/split.test.ts.

import { beforeEach, describe, expect, test } from "bun:test";
import type { ZproClient } from "@/modules/zpro/client";
import {
  __resetZproCrmCaches,
  loadZproQueues,
  loadZproStages,
  loadZproTags,
  matchZproStage,
  readZproCrmConfig,
  resolveZproPipelineId,
} from "@/modules/zpro/crm";

beforeEach(() => {
  __resetZproCrmCaches();
});

describe("readZproCrmConfig", () => {
  test("defaults when settings has no zproCrm key", () => {
    expect(readZproCrmConfig({})).toEqual({
      pipelineId: null,
      instructions: null,
    });
    expect(readZproCrmConfig(null)).toEqual({
      pipelineId: null,
      instructions: null,
    });
  });

  test("reads a valid pipelineId + instructions", () => {
    expect(
      readZproCrmConfig({
        zproCrm: {
          pipelineId: 16,
          instructions: "  Mover só após orçamento.  ",
        },
      }),
    ).toEqual({ pipelineId: 16, instructions: "Mover só após orçamento." });
  });

  test("rejects a non-positive/non-integer pipelineId", () => {
    expect(
      readZproCrmConfig({ zproCrm: { pipelineId: 0 } }).pipelineId,
    ).toBeNull();
    expect(
      readZproCrmConfig({ zproCrm: { pipelineId: -3 } }).pipelineId,
    ).toBeNull();
    expect(
      readZproCrmConfig({ zproCrm: { pipelineId: 1.5 } }).pipelineId,
    ).toBeNull();
    expect(
      readZproCrmConfig({ zproCrm: { pipelineId: "16" } }).pipelineId,
    ).toBeNull();
  });
});

describe("matchZproStage", () => {
  const stages = [
    { id: 1, name: "Novo" },
    { id: 2, name: "Proposta Enviada" },
  ];

  test("case-insensitive exact match", () => {
    expect(matchZproStage(stages, "proposta enviada")?.id).toBe(2);
    expect(matchZproStage(stages, "NOVO")?.id).toBe(1);
  });

  test("no match ⇒ null", () => {
    expect(matchZproStage(stages, "Fechado")).toBeNull();
    expect(matchZproStage(stages, "")).toBeNull();
  });
});

function client(overrides: Partial<ZproClient> = {}): ZproClient {
  return {
    listPipelines: async () => [],
    listStages: async () => [],
    listTags: async () => [],
    listQueues: async () => [],
    ...overrides,
  } as unknown as ZproClient;
}

describe("resolveZproPipelineId", () => {
  test("an explicit configured id is trusted even if not found in the list (defensive)", async () => {
    const c = client({
      listPipelines: async () => [{ id: 1, name: "Vendas" }],
    });
    const p = await resolveZproPipelineId(c, 999, "t1");
    expect(p).toEqual({ id: 999, name: "" });
  });

  test("an explicit configured id resolves its name when present", async () => {
    const c = client({
      listPipelines: async () => [{ id: 16, name: "Vendas" }],
    });
    const p = await resolveZproPipelineId(c, 16, "t1");
    expect(p).toEqual({ id: 16, name: "Vendas" });
  });

  test("no configured id + exactly one pipeline ⇒ auto-detected", async () => {
    const c = client({
      listPipelines: async () => [{ id: 16, name: "Vendas" }],
    });
    const p = await resolveZproPipelineId(c, null, "t1");
    expect(p).toEqual({ id: 16, name: "Vendas" });
  });

  test("no configured id + zero or 2+ pipelines ⇒ ambiguous, null", async () => {
    const none = client({ listPipelines: async () => [] });
    expect(await resolveZproPipelineId(none, null, "t2")).toBeNull();

    const many = client({
      listPipelines: async () => [
        { id: 1, name: "A" },
        { id: 2, name: "B" },
      ],
    });
    expect(await resolveZproPipelineId(many, null, "t3")).toBeNull();
  });

  test("caches the pipeline list per cache key within the TTL", async () => {
    let calls = 0;
    const c = client({
      listPipelines: async () => {
        calls++;
        return [{ id: 16, name: "Vendas" }];
      },
    });
    await resolveZproPipelineId(c, null, "same-key");
    await resolveZproPipelineId(c, null, "same-key");
    expect(calls).toBe(1);
  });
});

describe("loadZproStages / loadZproTags (defensive parsing)", () => {
  test("accepts a bare array", async () => {
    const c = client({
      listStages: async () => [
        { id: 1, name: "Novo" },
        { id: 2, name: "Proposta" },
      ],
    });
    const stages = await loadZproStages(c, 16, "t4");
    expect(stages).toEqual([
      { id: 1, name: "Novo" },
      { id: 2, name: "Proposta" },
    ]);
  });

  test("accepts a wrapped {data:[]} shape", async () => {
    const c = client({
      listStages: async () => ({ data: [{ id: 1, name: "Novo" }] }),
    });
    expect(await loadZproStages(c, 16, "t5")).toEqual([
      { id: 1, name: "Novo" },
    ]);
  });

  test("drops entries missing a valid id or name instead of throwing", async () => {
    const c = client({
      listStages: async () => [
        { id: 1, name: "Novo" },
        { id: "bad", name: "Ignored" },
        { id: 2 },
        null,
      ],
    });
    expect(await loadZproStages(c, 16, "t6")).toEqual([
      { id: 1, name: "Novo" },
    ]);
  });

  test("an unrecognized shape degrades to an empty list, never throws", async () => {
    const c = client({
      listStages: async () => "not a list" as unknown as never,
    });
    expect(await loadZproStages(c, 16, "t7")).toEqual([]);
  });

  test("loadZproTags parses the same way", async () => {
    const c = client({ listTags: async () => [{ id: 3, name: "vip" }] });
    expect(await loadZproTags(c, "t8")).toEqual([{ id: 3, name: "vip" }]);
  });

  test("loadZproQueues parses the same way and caches per key", async () => {
    let calls = 0;
    const c = client({
      listQueues: async () => {
        calls++;
        return [{ id: 5, name: "Suporte" }];
      },
    });
    expect(await loadZproQueues(c, "t9")).toEqual([{ id: 5, name: "Suporte" }]);
    expect(await loadZproQueues(c, "t9")).toEqual([{ id: 5, name: "Suporte" }]);
    expect(calls).toBe(1);
  });
});
