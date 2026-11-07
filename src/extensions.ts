/** Events. The MCP extension lives in mcp-extension.ts. */

/** An event on the plant's event bus. Modules never call each other directly. */
export interface PlantEvent<Data = unknown> {
  /** Unique id; listeners de-duplicate on it. */
  readonly id: string;
  /** e.g. `consent.recorded` */
  readonly type: string;
  readonly tenantId: string;
  /** The id of the module that emitted it. */
  readonly source: string;
  /** ISO 8601 timestamp. */
  readonly occurredAt: string;
  readonly data: Data;
}

export type { McpExtension, McpToolDescriptor } from "./mcp-extension.js";
