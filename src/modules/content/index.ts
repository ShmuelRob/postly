// Content: fact extraction, weekly planning, captions, and factual checks.
// Public surface of the module: other code imports only from this file (see ../README.md).

export { checkPlan, checkQuotes, type PlanContext } from './checks.js';
export { captionSources, checkCaptions, contentHash, factSources, type CaptionCheckContext, type ProfileSources } from './fact-check.js';
