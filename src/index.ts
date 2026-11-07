/**
 * @piquette/plant-sdk: the public contract between a plant and its modules.
 * MIT, copyright iamfiscus LLC. Must never import a private package.
 */
export type {
  Entitlements,
  MemberRole,
  PlantContext,
  Principal,
  SerializedPlantContext,
  Surface,
  Tenant,
} from "./context.js";
export type {
  Brand,
  BrandColorPath,
  BrandColors,
  BrandField,
  BrandFieldPath,
  BrandLock,
  PlantCssVar,
  ToCssVarsOptions,
} from "./brand.js";
export { BRAND_COLOR_KEYS, BRAND_FIELD_PATHS, brandLockCovers, isBrandFieldPath, PLANT_CSS_VARS, toCssVars } from "./brand.js";

export { createPlantContext, entitlementsFrom, isMemberRole, MEMBER_ROLES, serializePlantContext } from "./context.js";

export type { RoleRule } from "./roles.js";
export { hasRole, requiredRoleFor, requireRole, RoleError, roleAtLeast, roleOf, roleResponse } from "./roles.js";

export type { CallbackContext, ContextCapability } from "./capability.js";
export { callbackContext, capabilityOf, redactContext } from "./capability.js";

export type { JsonSchema, ModuleEvents, ModuleManifest, NavItem } from "./manifest.js";

export type { KeyStatus, ModuleKeyStatus, ModuleState, RequiredKey } from "./keys.js";
export { isOptionalKey, KEY_NAME, moduleState, normalizeRequiredKeys } from "./keys.js";

export type { PlantEvent } from "./extensions.js";

export type {
  McpExtension,
  McpExtensionDefinition,
  McpExtensionDescriptor,
  McpInvocation,
  McpInvocationError,
  McpInvocationErrorCode,
  McpInvocationResult,
  McpPrice,
  McpPromptArgumentDefinition,
  McpPromptArgumentDescriptor,
  McpPromptDefinition,
  McpPromptDescriptor,
  McpPromptInvocation,
  McpPromptMessage,
  McpResourceContents,
  McpResourceDefinition,
  McpResourceDescriptor,
  McpResourceInvocation,
  McpResourceReadResult,
  McpToolCall,
  McpToolDefinition,
  McpToolDefinitions,
  McpToolDescriptor,
  McpToolInvocation,
} from "./mcp-extension.js";
export {
  defineMcpExtension,
  isMcpExtension,
  MCP_NAME,
  MCP_NAMESPACE_SEPARATOR,
  MCP_RESOURCE_SCHEME,
  McpDefinitionError,
  mcpResourceUri,
} from "./mcp-extension.js";

export type { EventData, PlantEventRegistry, RegisteredEventType, TypedPlantEvent } from "./events.js";
export { isEventType } from "./events.js";

export type {
  DataSubject,
  DeletionProof,
  DeletionProofInput,
  PrivacyExport,
  PrivacyFindResult,
  PrivacyHandlers,
  PrivacyRecordRef,
  PrivacyVerifyResult,
  SubjectKey,
} from "./privacy.js";
export { createDeletionProof, hashSubject, MIN_SUBJECT_KEY_BYTES, normalizeSubject } from "./privacy.js";

export type { DeletionProofDetails, PrivacyContext, PrivacyService, Subjects } from "./subjects.js";
export {
  assertDataSubject,
  assertDeletionProofDetails,
  deletionProofFor,
  localPrivacyService,
  localSubjects,
  MOCK_SUBJECT_KEY_ENV,
  MockCorePrivacy,
  PRIVACY_BINDING,
  privacyContextFor,
  SUBJECT_LIMITS,
  subjectsVia,
  withSubjects,
} from "./subjects.js";

export type {
  DefinedModule,
  HandleFn,
  ModuleDefinition,
  ModuleHandlers,
  OnEventFn,
} from "./define.js";
export { defineModule, ModuleDefinitionError } from "./define.js";

export type {
  Actor,
  AgentContext,
  AgentDefinition,
  AgentEventFn,
  AgentHandlers,
  AgentInitialData,
  AgentManifestEntry,
  AgentPrincipal,
  AgentScheduleFn,
  AgentSpec,
  AgentTick,
  AgentTimeZone,
  Proposal,
  ProposalEvidence,
  ProposalSeverity,
  SerializedAgentScope,
  SuggestedToolCall,
} from "./agents.js";
export {
  actorId,
  agentConversationId,
  agentPrincipal,
  conversationBelongsTo,
  conversationTenant,
  createAgentEventContext,
  createAgentScheduleContext,
  eventIdempotencyKey,
  eventsConversationId,
  inboxConversationId,
  isAgentPrincipal,
  isCronPattern,
  PROPOSAL_LIMITS,
  PROPOSAL_SEVERITIES,
  scheduleIdempotencyKey,
  sweepConversationId,
  utcDate,
  validateProposal,
} from "./agents.js";
export type { AgentEventInit, AgentHarness, AgentHarnessOptions, AgentRun } from "./agent-harness.js";
export { createAgentHarness } from "./agent-harness.js";

export type { CreateModuleKeysOptions, KeyValues } from "./module-keys.js";
export { createModuleKeys, ModuleKeys, moduleKeys, REDACTED, withModuleKeys } from "./module-keys.js";
/** For the plant's core when it runs a module's own MCP tools in-process (the agent tools bridge), as PlantModule does. */
export { guardKeys, scrubKeyValues } from "./module-keys.js";

export type { PrivacyRpc } from "./module.js";
export { moduleEntrypoint, PlantModule } from "./module.js";

export { MCP_WIRE_NAME, MCP_WIRE_NAME_MAX, MCP_WIRE_SEPARATOR, mcpDisplayLabel, mcpWireName, parseMcpWireName } from "./mcp-wire.js";

export type {
  HarnessCallOptions,
  HarnessDraft,
  HarnessEventInit,
  HarnessMcp,
  HarnessPrivacy,
  HarnessPrompt,
  HarnessResource,
  HarnessTool,
  ModuleHarness,
  ModuleHarnessOptions,
  ModuleRpcTarget,
} from "./harness.js";
export {
  createModuleHarness,
  HARNESS_BRAND,
  HARNESS_GATE_HEADER,
  HARNESS_PRINCIPAL,
  HARNESS_ROLE,
  HARNESS_TENANT,
  HarnessError,
  MODULE_STATE_HEADER,
} from "./harness.js";

export type { AgentRunRefresher, AgentStepConfig, AgentStepContext, WorkflowAgentRun, WorkflowStepLike } from "./workflow-steps.js";
export { agentStep, containsCapability, redactCapabilities } from "./workflow-steps.js";
