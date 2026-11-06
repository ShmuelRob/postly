-- Hand-written (2026-11-06): every model task moves to Gemini 3.5 Flash-Lite (agent.md, A8;
-- technical-design.md, Models). Vertex AI retired gemini-2.5-flash and gemini-2.5-flash-lite on
-- 2026-10-20, so every call on them now fails with "model not found". 0010 and 0017 are applied history
-- and are not edited. Temperatures, max_cost_usd and retries stay; no fallback model.
UPDATE "model_task_config"
SET "provider" = 'google', "model" = 'gemini-3.5-flash-lite', "fallback_provider" = NULL, "fallback_model" = NULL;
