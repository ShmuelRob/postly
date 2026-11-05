# תקציר: ניטור ולוגים

מסמך המקור: [observability.md](observability.md).

- **לוגר אחד** ב-`src/shared/logger.ts` לכל התהליכים (web, worker, console, migrate). אסור `console.*` במקום אחר ב-`src/`; בדיקה נכשלת אם יש.
- **פורמט:** שורת JSON אחת ב-stdout בפורמט ש-Google Cloud Logging קורא: `severity`, `message` קבוע באנגלית, `time`, שדה ה-trace, ו-labels עם המזהים.
- **מזהי קישור:** `AsyncLocalStorage` נושא את `requestId`, `businessId`, `messageId`, `jobId`, `jobName` ו-`process`. השרת פותח הקשר לכל בקשה, כל job רץ בהקשר משלו, וטיפול בהודעה נכנסת מוסיף את מזהי העסק וההודעה.
- **בלי תוכן לקוח, מספרי טלפון או סודות:** שדות בשמות כמו `text`, `phone`, `token`, `password` מוחלפים ב-`[redacted]`; בכל מחרוזת מוחלפים מספרי טלפון, סיסמאות ב-URL, טוקני Bearer ומחרוזות דמויות מפתח. מחרוזות נחתכות ב-500 תווים. בדיקה נכשלת אם תוכן או סוד מגיעים לשורת לוג.
- **שמירה:** 7 ימים ב-dev, 30 ב-stage וב-prod.
- **מדדים (WP-48):** קטלוג אחד ב-`src/shared/telemetry.ts` (בדיקה משווה אותו לטבלה במסמך). בסביבות dev, stage ו-prod המדדים נשלחים ל-Cloud Monitoring בשם `workload.googleapis.com/postly.*`: הודעות נכנסות ויוצאות, טיוטות, אישורים, פרסומים לפי תוצאה ורשת, קריאות מודל עם עלות וזמן לכל משימה, משך jobs וכשלונות, ועומק תור. חיבורי מסד הנתונים נלקחים מהמדד של Cloud SQL.
- **בלי תוכן לקוח במדדים:** כל ערך label הוא מרשימה קבועה או קבוע מהקוד; ערך אחר הופך ל-`other`. אין label של מזהה עסק; תצוגה לפי עסק נבנית מהלוגים.
- **Tracing (WP-48):** Cloud Trace דרך OpenTelemetry, דגימה של 10%. spans לבקשה, ל-job, לקריאת מודל ולפרסום. רק מזהים ומילות קוד קצרות נכנסים כ-attributes; כל השאר נזרק. שורות לוג בתוך span נושאות את מזהי ה-trace וה-span.
- **Error Reporting (WP-48):** כל שורת לוג ברמת `ERROR` היא גם אירוע שגיאה (`@type` ו-`serviceContext`), עם `stack_trace` אחרי ניקוי כשיש אובייקט שגיאה.
- לוחות והתראות (WP-49) ו-runbook (WP-50) יורחבו כאן.
