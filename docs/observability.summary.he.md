# תקציר: ניטור ולוגים

מסמך המקור: [observability.md](observability.md).

- **לוגר אחד** ב-`src/shared/logger.ts` לכל התהליכים (web, worker, console, migrate). אסור `console.*` במקום אחר ב-`src/`; בדיקה נכשלת אם יש.
- **פורמט:** שורת JSON אחת ב-stdout בפורמט ש-Google Cloud Logging קורא: `severity`, `message` קבוע באנגלית, `time`, שדה ה-trace, ו-labels עם המזהים.
- **מזהי קישור:** `AsyncLocalStorage` נושא את `requestId`, `businessId`, `messageId`, `jobId`, `jobName` ו-`process`. השרת פותח הקשר לכל בקשה, כל job רץ בהקשר משלו, וטיפול בהודעה נכנסת מוסיף את מזהי העסק וההודעה.
- **בלי תוכן לקוח, מספרי טלפון או סודות:** שדות בשמות כמו `text`, `phone`, `token`, `password` מוחלפים ב-`[redacted]`; בכל מחרוזת מוחלפים מספרי טלפון, סיסמאות ב-URL, טוקני Bearer ומחרוזות דמויות מפתח. מחרוזות נחתכות ב-500 תווים. בדיקה נכשלת אם תוכן או סוד מגיעים לשורת לוג.
- **שמירה:** 7 ימים ב-dev, 30 ב-stage וב-prod.
- מדדים ו-tracing (WP-48), לוחות והתראות (WP-49) ו-runbook (WP-50) יורחבו כאן.
