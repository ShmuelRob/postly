// Console: conversations, drafts, errors, manual intervention, and the global pause.
// Public surface of the module: other code imports only from this file (see ../README.md).

export { ConsoleActionError, createConsole, type BusinessSummary, type ConsoleService, type Draft } from './console.js';
export type {
  AgentConfigPatch,
  AgentConfigRow,
  AgentTurnSummary,
  BusinessDetail,
  BusinessRow,
  ConsoleActionRow,
  FailureRow,
  ModelRunRow,
  ModelRunSummary,
  ModelTaskPatch,
  ModelTaskRow,
  Overview,
  PostDetail,
  PublicationDetail,
  SystemSettings,
  VersionDetail,
  WriteMeta,
} from './views.js';
export { CONSOLE_PATH, consoleActor, DEV_ACTOR, registerConsoleRoutes, type ConsoleAuth, type ConsoleRouteOptions } from './routes.js';
export { createIapVerifier, IAP_AUDIENCE_FORMS, IAP_AUDIENCE_PATTERN, IAP_HEADER, IAP_ISSUER, IapAssertionError, type IapIdentity, type IapPublicKey, type IapVerifier } from './iap.js';
