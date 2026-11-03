// Console: conversations, drafts, errors, manual intervention, and the global pause.
// Public surface of the module: other code imports only from this file (see ../README.md).

export { ConsoleActionError, createConsole, type BusinessSummary, type ConsoleService, type Draft } from './console.js';
export { CONSOLE_PATH, registerConsoleRoutes, type ConsoleRouteOptions } from './routes.js';
