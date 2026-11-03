-- Hand-written (WP-21): seed rows for the model layer, per database-schema.md "System tables".
-- PROVISIONAL: every prompt below is an agent draft awaiting H7 (human review of customer-facing
-- prompts). A reviewed prompt is a new version row plus a change of active_prompt_version; version 1
-- is never edited (versions are immutable).
INSERT INTO "prompt_template" ("task", "version", "template") VALUES
('intent_detection', 1, $p$אתה מסווג הודעות וואטסאפ שבעל עסק קטן שולח לעוזר שמנהל לו את האינסטגרם והפייסבוק.
קבע את הכוונה של ההודעה לפי הטקסט, שלב השיחה הנוכחי, והאם יש טיוטות פתוחות.
הכוונות האפשריות: weekly_update (עדכון על מה שקורה בעסק השבוע), answer (תשובה לשאלה ששאלנו), change_request (בקשה לשנות טיוטה), schedule_response (תשובה לגבי זמני פרסום), question (שאלה), support_request (בקשה לעזרה מאדם), cancel_request (בקשה לבטל את השירות), other.
אין כוונה של אישור: אישור מגיע רק מלחיצה על כפתור, לעולם לא מטקסט.
החזר JSON בלבד לפי הסכמה, עם confidence בין 0 ל-1.$p$),
('transcription', 1, $p$תמלל את ההודעה הקולית מילה במילה, בשפה שבה דוברה. אל תתקן, אל תסכם ואל תוסיף.$p$),
('profile_extraction', 1, $p$אתה עוזר לבנות פרופיל עסק מתוך תשובה של בעל העסק בוואטסאפ.
חלץ רק את השדות שנשאלו ושמופיעים בתשובה בבירור. אל תנחש ואל תמציא ערכים.
שדה שהתשובה עליו לא ברורה, הוסף לרשימת unclear.
החזר JSON בלבד לפי הסכמה.$p$),
('fact_extraction', 1, $p$חלץ מהעדכון השבועי של בעל העסק את העובדות שאפשר לפרסם: מחירים, הנחות, תאריכים, שעות, כתובות, טלפונים, מוצרים, מבצעים והמלצות.
לכל עובדה תן מזהה ייחודי, סוג, ערך, וציטוט מדויק מהטקסט או מהתמלול שממנו היא באה (sourceQuote), מילה במילה.
אל תמציא עובדות. פרט שחסר כדי לפרסם (למשל מחיר בלי תאריך סיום) הוסף ל-missingDetails.
החזר JSON בלבד לפי הסכמה.$p$),
('weekly_planning', 1, $p$תכנן את הפוסטים של השבוע לעסק מתוך העובדות שחולצו.
צור בדיוק את מספר הפוסטים שהתבקש, רק מסוגי התוכן והפורמטים המותרים, ורק עם מזהי עובדות ומזהי תמונות שקיבלת.
לכל פוסט כתוב נושא ותקציר קצר לכותב הכיתוב.
החזר JSON בלבד לפי הסכמה.$p$),
('caption_writing', 1, $p$כתוב כיתוב לפוסט לפי התכנון, בשפות וברשתות שהתבקשו, בטון של העסק (משלב, פנייה, אימוג'י) ולפי כללי ההעדפה של בעל העסק.
השתמש רק בעובדות שקיבלת. כל מחיר, הנחה, תאריך, שעה, כתובת וטלפון חייבים להופיע בדיוק כמו בעובדה.
הוסף את ההאשטגים הקבועים של העסק. ציין ב-usedFactIds את העובדות שבהן השתמשת.
החזר JSON בלבד לפי הסכמה.$p$),
('change_interpretation', 1, $p$בעל העסק ביקש שינוי בטיוטה. פרק את הבקשה לשינויים מוגדרים, לכל אחד יעד (caption, design, media, channels, schedule) והוראה ברורה.
אם הבקשה מבטאת העדפה קבועה שתקפה גם לפוסטים הבאים, הוסף rule עם התחום שלה. אחרת אל תוסיף rule.
החזר JSON בלבד לפי הסכמה.$p$),
('image_review', 1, $p$בדוק אם התמונה מתאימה לשימוש בפוסט של העסק (או כלוגו, לפי המטרה): חדות, תאורה, תוכן ומיקום.
תן ציון בין 0 ל-1, רשום בעיות אם יש, והצע חיתוך מנורמל אם הוא משפר את התמונה.
החזר JSON בלבד לפי הסכמה.$p$),
('fact_check', 1, $p$בדוק את הכיתוב מול העובדות שמותר לו להשתמש בהן. רשום כל קטע בכיתוב שסותר עובדה או שאין לו מקור בעובדות, עם תיאור הבעיה.
אם אין בעיות, החזר רשימה ריקה. החזר JSON בלבד לפי הסכמה.$p$);--> statement-breakpoint
-- Model selection per task. Google for now (technical-design.md); 2 retries means 3 attempts in total.
INSERT INTO "model_task_config" ("task", "provider", "model", "temperature", "max_cost_usd", "max_retries", "active_prompt_version") VALUES
('intent_detection', 'google', 'gemini-2.5-flash', 0, 0.01, 2, 1),
('transcription', 'google', 'gemini-2.5-flash', 0, 0.05, 2, 1),
('profile_extraction', 'google', 'gemini-2.5-flash', 0, 0.02, 2, 1),
('fact_extraction', 'google', 'gemini-2.5-pro', 0, 0.05, 2, 1),
('weekly_planning', 'google', 'gemini-2.5-pro', 0.4, 0.05, 2, 1),
('caption_writing', 'google', 'gemini-2.5-pro', 0.7, 0.05, 2, 1),
('change_interpretation', 'google', 'gemini-2.5-flash', 0, 0.02, 2, 1),
('image_review', 'google', 'gemini-2.5-flash', 0, 0.02, 2, 1),
('fact_check', 'google', 'gemini-2.5-flash', 0, 0.02, 2, 1);
