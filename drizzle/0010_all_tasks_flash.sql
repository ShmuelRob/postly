-- Hand-written (T5): every model task runs on a Gemini Flash model through Vertex AI for now
-- (technical-design.md, Models). 0003 is applied history and is not edited; this moves the three tasks
-- it put on gemini-2.5-pro. No fallback model: the retries stay on the same model.
UPDATE "model_task_config"
SET "provider" = 'google', "model" = 'gemini-2.5-flash', "fallback_provider" = NULL, "fallback_model" = NULL;
