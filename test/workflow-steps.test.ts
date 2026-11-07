import { describe, expect, it, vi } from "vitest";
import {
  agentStep,
  callbackContext,
  containsCapability,
  redactCapabilities,
  type AgentStepConfig,
  type CallbackContext,
  type ContextCapability,
  type SerializedAgentScope,
  type WorkflowStepLike,
} from "../src/index.js";

// Fake capabilities: the SDK treats them as opaque strings.
const SEED = "pcap1.c2VlZA.bWFj" as ContextCapability;
const FRESH = "pcap1.ZnJlc2g.bWFjMg" as ContextCapability;
const tenant = { id: "t_1", hostname: "acme.example.com" };
const seedScope: SerializedAgentScope = { tenant, entitlements: ["ads.pro"], capability: SEED };

/** A stand-in for WorkflowStep that records what each step persisted. */
function fakeStep() {
  const persisted: Array<{ name: string; config: AgentStepConfig; result?: unknown; error?: string }> = [];
  const step: WorkflowStepLike = {
    async do<T>(name: string, config: AgentStepConfig, cb: () => Promise<T>): Promise<T> {
      try {
        const result = await cb();
        persisted.push({ name, config, result });
        return result;
      } catch (e) {
        persisted.push({ name, config, error: `${(e as Error).name}: ${(e as Error).message}\n${(e as Error).stack}` });
        throw e;
      }
    },
  };
  return { step, persisted };
}

function fakeCore(answer: (ctx: CallbackContext) => SerializedAgentScope = () => ({ tenant, entitlements: ["ads.pro"], capability: FRESH })) {
  return { refresh: vi.fn(async (ctx: CallbackContext) => answer(ctx)) };
}

describe("agentStep", () => {
  it("refreshes inside the step with the seed scope and hands fn the fresh capability, held off the object", async () => {
    const { step, persisted } = fakeStep();
    const core = fakeCore();
    const out = await agentStep(step, "poll", { scope: seedScope, core }, async (ctx) => {
      expect(Object.values(ctx)).not.toContain(FRESH);
      expect(JSON.stringify(ctx)).not.toContain("pcap1.");
      expect(ctx.entitlements.has("ads.pro")).toBe(true);
      expect(callbackContext(ctx)).toEqual({ tenant: { id: "t_1" }, capability: FRESH });
      return { changed: 2 };
    });
    expect(out).toEqual({ changed: 2 });
    expect(core.refresh).toHaveBeenCalledOnce();
    expect(core.refresh.mock.calls[0]![0]).toEqual({ tenant: { id: "t_1" }, capability: SEED });
    expect(persisted).toEqual([{ name: "poll", config: {}, result: { changed: 2 } }]);
  });

  it("refreshes once per step, every step", async () => {
    const { step } = fakeStep();
    const core = fakeCore();
    for (const name of ["a", "b", "c"]) await agentStep(step, name, { scope: seedScope, core }, async () => name);
    expect(core.refresh).toHaveBeenCalledTimes(3);
  });

  it("passes the step config through", async () => {
    const { step, persisted } = fakeStep();
    const config = { retries: { limit: 0, delay: 0 }, timeout: "5 minutes" };
    await agentStep(step, "x", { scope: seedScope, core: fakeCore() }, async () => 1, config);
    expect(persisted[0]!.config).toEqual(config);
  });

  it("refuses to persist a result that contains a capability, wherever it is", async () => {
    for (const leak of [
      (ctx: unknown) => callbackContext(ctx as { tenant: { id: string } }),
      () => ({ nested: [{ deep: new Map([["k", `Bearer ${FRESH}`]]) }] }),
      () => SEED,
    ]) {
      const { step, persisted } = fakeStep();
      await expect(agentStep(step, "leaky", { scope: seedScope, core: fakeCore() }, async (ctx) => leak(ctx))).rejects.toThrow(
        /returned a capability/,
      );
      expect(persisted.map((p) => p.result)).toEqual([undefined]);
      expect(JSON.stringify(persisted)).not.toContain("pcap1.");
    }
  });

  it("strips capabilities from errors before the Workflow records them", async () => {
    const { step, persisted } = fakeStep();
    const err = await agentStep(step, "boom", { scope: seedScope, core: fakeCore() }, async (ctx) => {
      throw new Error(`upstream rejected ${callbackContext(ctx).capability} for ${SEED}`, { cause: { capability: FRESH } });
    }).catch((e: unknown) => e as Error);
    expect(err.message).toBe("upstream rejected [capability] for [capability]");
    expect(containsCapability(err)).toBe(false);
    expect(JSON.stringify(persisted)).not.toContain("pcap1.");
  });

  it("fails the step when core refuses, without a capability in the error", async () => {
    const { step, persisted } = fakeStep();
    const core = {
      refresh: vi.fn(async () => {
        throw new Error("context capability refused (grace-expired): the run started too long ago to refresh its capability");
      }),
    };
    const fn = vi.fn(async () => 1);
    await expect(agentStep(step, "late", { scope: seedScope, core }, fn)).rejects.toThrow(/grace-expired/);
    expect(fn).not.toHaveBeenCalled();
    expect(JSON.stringify(persisted)).not.toContain("pcap1.");
  });

  it("fails the step when core answers for another tenant", async () => {
    const { step } = fakeStep();
    const core = fakeCore(() => ({ tenant: { id: "t_2", hostname: "globex.example.com" }, entitlements: [], capability: FRESH }));
    await expect(agentStep(step, "x", { scope: seedScope, core }, async () => 1)).rejects.toThrow(/another tenant/);
  });

  it("needs a seed scope with a capability and a core binding", async () => {
    const { step } = fakeStep();
    await expect(agentStep(step, "x", { scope: { tenant, entitlements: [] }, core: fakeCore() }, async () => 1)).rejects.toThrow(
      /no capability/,
    );
    await expect(agentStep(step, "x", { scope: seedScope, core: {} as never }, async () => 1)).rejects.toThrow(/AgentRuns/);
  });
});

describe("containsCapability / redactCapabilities", () => {
  const nest = (depth: number, leaf: unknown): unknown => {
    let v = leaf;
    for (let i = 0; i < depth; i++) v = { next: v };
    return v;
  };

  it("passes plain data, including shared (non-cyclic) references", () => {
    const shared = { receipt: "sub_ik_123" };
    expect(containsCapability({ receipt: "sub_ik_123", n: 2, at: new Date(0), list: [shared, shared], m: new Map([["k", 1]]) })).toBe(false);
    expect(containsCapability(undefined)).toBe(false);
    expect(containsCapability(nest(60, "ok"))).toBe(false);
  });

  it("fails closed: a capability 70 levels deep, and anything past the depth limit, is refused", () => {
    expect(containsCapability(nest(70, FRESH))).toBe(true);
    expect(containsCapability(nest(70, "clean"))).toBe(true);
  });

  it("finds a capability behind a repeated reference, even when it is first reached past the depth limit", () => {
    const shared = { cap: FRESH };
    expect(containsCapability({ a: shared, b: shared })).toBe(true);
    expect(containsCapability({ deep: nest(70, shared), shallow: shared })).toBe(true);
  });

  it("fails closed on cycles", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(containsCapability(cyclic)).toBe(true);
  });

  it("finds capabilities in Map keys and values, Sets, class instances, keys, bytes and errors", () => {
    class Receipt {
      readonly id = "sub_ik_1";
      constructor(readonly note: string) {}
    }
    const errWithName = new Error("plain");
    errWithName.name = `Leak ${FRESH}`;
    const errWithProp = Object.assign(new Error("plain"), { detail: { token: FRESH } });
    for (const leak of [
      new Map([[FRESH, 1]]),
      new Map([["k", { v: FRESH }]]),
      new Set([`x ${FRESH}`]),
      new Receipt(`see ${SEED}`),
      { [FRESH]: true },
      new TextEncoder().encode(FRESH),
      errWithName,
      errWithProp,
      new Error("plain", { cause: { capability: FRESH } }),
    ]) {
      expect(containsCapability(leak)).toBe(true);
    }
  });

  it("refuses what can't be serialized, since it can't be checked", () => {
    expect(containsCapability({ fn: () => FRESH })).toBe(true);
  });

  it("redacts every capability in a string", () => {
    expect(redactCapabilities(`a ${SEED} b ${FRESH}.`)).toBe("a [capability] b [capability].");
  });
});

describe("agentStep fails closed on results it can't check, and redacts every part of an error", () => {
  it("refuses deep, shared-reference, Map, Set and class-instance leaks before they are persisted", async () => {
    class Holder {
      constructor(readonly inner: unknown) {}
    }
    for (const make of [
      () => {
        let v: unknown = FRESH;
        for (let i = 0; i < 70; i++) v = { next: v };
        return v;
      },
      () => {
        const shared = { cap: FRESH };
        let deep: unknown = shared;
        for (let i = 0; i < 70; i++) deep = { next: deep };
        return { deep, shared };
      },
      () => new Map([["k", FRESH]]),
      () => ({ s: new Set([FRESH]) }),
      () => new Holder({ cap: FRESH }),
    ]) {
      const { step, persisted } = fakeStep();
      await expect(agentStep(step, "leaky", { scope: seedScope, core: fakeCore() }, async () => make())).rejects.toThrow(/returned a capability/);
      expect(persisted.map((p) => p.result)).toEqual([undefined]);
    }
  });

  it("redacts err.name, the stack, the cause and own enumerable properties", async () => {
    const { step, persisted } = fakeStep();
    const err = await agentStep(step, "boom", { scope: seedScope, core: fakeCore() }, async () => {
      const e = new Error(`bad ${FRESH}`, { cause: { inner: [FRESH], deep: new Error(`nested ${SEED}`) } });
      e.name = `Leak${FRESH}`;
      e.stack = `Leak: ${FRESH}\n    at x`;
      Object.assign(e, { capability: FRESH, nested: { list: [SEED] } });
      throw e;
    }).catch((e: unknown) => e as Error & Record<string, unknown>);
    expect(err.name).toBe("Leak[capability]");
    expect(err.message).toBe("bad [capability]");
    expect(err.stack).not.toContain("pcap1.");
    expect(err.capability).toBe("[capability]");
    expect(err.nested).toEqual({ list: ["[capability]"] });
    expect(containsCapability(err)).toBe(false);
    expect(containsCapability(err.cause)).toBe(false);
    expect(JSON.stringify(persisted)).not.toContain("pcap1.");
  });

  it("withholds an error it can't redact rather than pass it on", async () => {
    const { step } = fakeStep();
    const err = await agentStep(step, "boom", { scope: seedScope, core: fakeCore() }, async () => {
      throw Object.assign(new Error("x"), { bytes: new TextEncoder().encode(FRESH), [`k${FRESH}`]: 1 });
    }).catch((e: unknown) => e as Error);
    expect(containsCapability(err)).toBe(false);
  });

  it("refuses a step name that contains a capability", async () => {
    const { step, persisted } = fakeStep();
    await expect(agentStep(step, `step ${FRESH}`, { scope: seedScope, core: fakeCore() }, async () => 1)).rejects.toThrow(/step name/);
    expect(persisted).toEqual([]);
  });
});
