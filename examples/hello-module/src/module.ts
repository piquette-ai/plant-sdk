/**
 * hello: the smallest useful plant module. It uses only @piquette/plant-sdk
 * (and zod for MCP schemas).
 *
 * - App route `/` (behind Access): a branded greeting for the signed-in person.
 * - Public routes under `/public`: `GET /public/hello` and
 *   `POST /public/guestbook` (`{ email, message }`).
 * - MCP: `list_entries` (read) and `add_entry` (write, draft-first). Core
 *   exposes them as `hello__list_entries` and `hello__add_entry`.
 * - Privacy: guestbook entries are personal data, so find, export, delete
 *   (with a deletion proof) and verify are implemented. The proof comes from
 *   `ctx.subjects`, which asks core (over the PLANT_PRIVACY binding) to hash
 *   the subject: the module never sees a subject key.
 * - requiredKeys: `HELLO_API_KEY`, so the plant shows a setup page until it's set.
 * - Agent: `tidy` runs daily at 06:00 UTC and records when it last ran.
 */
import {
  defineMcpExtension,
  defineModule,
  normalizeSubject,
  toCssVars,
  type DataSubject,
  type PlantContext,
  type PrivacyService,
} from "@piquette/plant-sdk";
import * as z from "zod";

export interface Env {
  readonly GREETINGS: KVNamespace;
  /**
   * The service binding to core's Privacy entrypoint. `ctx.subjects` in the
   * privacy handlers uses it; the module never holds a subject key.
   */
  readonly PLANT_PRIVACY: PrivacyService;
}

interface Entry {
  readonly id: string;
  readonly email: string;
  readonly message: string;
  readonly createdAt: string;
  readonly draftId?: string;
}

const ENTRY_TYPE = "hello.guestbook_entry";

// Every key is scoped by tenant. The tenant always comes from the router's context.
const prefix = (ctx: PlantContext) => `${ctx.tenant.id}/entry/`;

async function addEntry(env: Env, ctx: PlantContext, email: string, message: string, draftId?: string): Promise<Entry> {
  const entry: Entry = {
    id: crypto.randomUUID(),
    email: email.trim().toLowerCase(),
    message,
    createdAt: new Date().toISOString(),
    ...(draftId ? { draftId } : {}),
  };
  await env.GREETINGS.put(prefix(ctx) + entry.id, JSON.stringify(entry));
  return entry;
}

async function listEntries(env: Env, ctx: PlantContext): Promise<Entry[]> {
  const out: Entry[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.GREETINGS.list({ prefix: prefix(ctx), ...(cursor ? { cursor } : {}) });
    for (const k of page.keys) {
      const e = await env.GREETINGS.get<Entry>(k.name, "json");
      if (e) out.push(e);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Entries about one subject. This module only knows subjects by email. */
async function entriesFor(env: Env, ctx: PlantContext, subject: DataSubject): Promise<Entry[]> {
  normalizeSubject(subject); // throws when the subject has no identifier
  const email = subject.email?.trim().toLowerCase();
  if (!email) return [];
  return (await listEntries(env, ctx)).filter((e) => e.email === email);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const entrySchema = z.object({ id: z.string(), message: z.string(), createdAt: z.string() });

const mcp = defineMcpExtension<Env>()({
  tools: {
    list_entries: {
      description: "List the guestbook entries for this tenant (messages only, no emails).",
      input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      output: z.object({ entries: z.array(entrySchema) }),
      run: async ({ limit }, ctx, env) => ({
        entries: (await listEntries(env, ctx)).slice(0, limit).map(({ id, message, createdAt }) => ({ id, message, createdAt })),
      }),
    },
    add_entry: {
      description: "Add a guestbook entry. Draft-first: runs only after a person approves it.",
      input: z.object({ email: z.email(), message: z.string().min(1).max(500) }),
      output: z.object({ id: z.string(), draftId: z.string() }),
      write: true,
      run: async ({ email, message }, ctx, env, { draftId }) => {
        const entry = await addEntry(env, ctx, email, message, draftId);
        return { id: entry.id, draftId: draftId! };
      },
    },
  },
});

export const hello = defineModule<Env>({
  id: "hello",
  name: "Hello",
  version: "0.1.0",
  coreRange: "^0.1.0",
  nav: [{ label: "Hello", path: "/" }],
  publicPrefixes: ["/public"],
  requires: ["hello.basic"],
  requiredKeys: [{ name: "HELLO_API_KEY", description: "Demo key. The hello module only needs it to be set." }],
  agents: [
    {
      name: "tidy",
      description: "Daily housekeeping. Keep schedule handlers thin; real agents start a Workflow here.",
      schedule: "0 6 * * *",
      onSchedule: async (tick, ctx, env) => {
        await env.GREETINGS.put(`${ctx.tenant.id}/tidy/last`, tick.scheduledAt);
      },
    },
  ],

  async handle(request, ctx, env) {
    const url = new URL(request.url);
    const path = url.pathname.slice(ctx.basePath.length) || "/";

    if (ctx.surface === "app" && path === "/" && request.method === "GET") {
      const count = (await listEntries(env, ctx)).length;
      const tidied = await env.GREETINGS.get(`${ctx.tenant.id}/tidy/last`);
      const html =
        `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(ctx.brand.name)}</title>` +
        `<style>${toCssVars(ctx.brand)}</style></head><body>` +
        `<h1>Hello, ${escapeHtml(ctx.principal!.email)}</h1>` +
        `<p>${count} guestbook ${count === 1 ? "entry" : "entries"} on ${escapeHtml(ctx.tenant.hostname)}.</p>` +
        (tidied ? `<p>Last tidied ${escapeHtml(tidied)}.</p>` : "") +
        `</body></html>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (path === "/public/hello" && request.method === "GET") {
      return Response.json({ message: `Hello from ${ctx.brand.name}`, hostname: ctx.tenant.hostname, surface: ctx.surface });
    }

    if (path === "/public/guestbook" && request.method === "POST") {
      const parsed = z.object({ email: z.email(), message: z.string().min(1).max(500) }).safeParse(await request.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
      const entry = await addEntry(env, ctx, parsed.data.email, parsed.data.message);
      return Response.json({ id: entry.id }, { status: 201 });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },

  mcp,

  privacy: {
    async find(subject, ctx, env) {
      const entries = await entriesFor(env, ctx, subject);
      return { records: entries.map((e) => ({ type: ENTRY_TYPE, id: e.id, location: "kv:GREETINGS" })) };
    },
    async export(subject, ctx, env) {
      const entries = await entriesFor(env, ctx, subject);
      return { format: "json", records: entries.map((e) => ({ type: ENTRY_TYPE, id: e.id, location: "kv:GREETINGS", data: e })) };
    },
    async delete(subject, ctx, env) {
      const entries = await entriesFor(env, ctx, subject);
      await Promise.all(entries.map((e) => env.GREETINGS.delete(prefix(ctx) + e.id)));
      // Core hashes the subject with the tenant's key and fills in the module and tenant.
      return ctx.subjects.deletionProof(subject, { deleted: [{ type: ENTRY_TYPE, count: entries.length }] });
    },
    async verify(subject, ctx, env) {
      const remaining = (await entriesFor(env, ctx, subject)).map((e) => ({ type: ENTRY_TYPE, id: e.id }));
      return { clean: remaining.length === 0, remaining, checkedAt: new Date().toISOString() };
    },
  },
});
