import type { Brand, ModuleDefinition, SerializedPlantContext } from "../src/index.js";

export const brand: Brand = {
  name: "Acme",
  logoUrl: "https://acme.example.com/logo.svg",
  faviconUrl: "https://acme.example.com/favicon.ico",
  colors: { primary: "#0b5fff", accent: "#ff7a00", bg: "#ffffff", fg: "#111827", muted: "#6b7280" },
  font: "Inter, system-ui, sans-serif",
  supportEmail: "help@acme.example.com",
  emailFromName: "Acme Support",
  poweredBy: true,
};

export const appCtx: SerializedPlantContext = {
  tenant: { id: "t_1", hostname: "acme.example.com", parentId: "t_root" },
  principal: { email: "ops@acme.example.com", groups: ["admins"] },
  brand,
  entitlements: ["consent.pro", "consent.basic"],
  basePath: "/consent",
  surface: "app",
};

export const publicCtx: SerializedPlantContext = { ...appCtx, principal: null, surface: "public" };

export function baseDef(overrides: Partial<ModuleDefinition> = {}): ModuleDefinition {
  return {
    id: "consent",
    name: "Consent",
    version: "0.1.0",
    coreRange: "^0.1.0",
    handle: () => new Response("ok"),
    ...overrides,
  };
}
