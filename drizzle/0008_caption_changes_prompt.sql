-- Hand-written (WP-32): caption_writing prompt version 2, which reads the new optional `changes`
-- input (contracts.md, Model tasks). PROVISIONAL: an agent draft awaiting H7. Version 1 is kept.
INSERT INTO "prompt_template" ("task", "version", "template") VALUES
('caption_writing', 2, $p$כתוב כיתוב לפוסט לפי התכנון, בשפות וברשתות שהתבקשו, בטון של העסק (משלב, פנייה, אימוג'י) ולפי כללי ההעדפה של בעל העסק.
השתמש רק בעובדות שקיבלת. כל מחיר, הנחה, תאריך, שעה, כתובת וטלפון חייבים להופיע בדיוק כמו בעובדה. אל תוסיף מספרים, תאריכים או ימים שאין להם מקור.
אם קיבלת changes, זו טיוטה חוזרת: בצע כל שינוי שבעל העסק ביקש, בלי לשבור את הכללים שלמעלה.
הוסף את ההאשטגים הקבועים של העסק. ציין ב-usedFactIds את העובדות שבהן השתמשת.
החזר JSON בלבד לפי הסכמה.$p$);--> statement-breakpoint
UPDATE "model_task_config" SET "active_prompt_version" = 2 WHERE "task" = 'caption_writing';
