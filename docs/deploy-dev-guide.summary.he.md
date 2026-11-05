# פריסת dev בפעם הראשונה: תקציר

תקציר של [deploy-dev-guide.md](deploy-dev-guide.md). את הפקודות המלאות (PowerShell, Windows) יש לקחת משם. סוכנים לא מריצים את השלבים האלה; רק האדם.

1. **כלים:** gcloud, ‏Terraform ‏1.13.x (קובצי ה-lock נועלים את google 7.46.2, ‏random 3.9.1, ‏github 6.13.0), ‏gh ו-Docker Desktop. התחברות: `gcloud auth login`, ‏`gcloud auth application-default login`, ‏`gh auth login`, וטוקן GitHub מסוג fine-grained עם הרשאות כתיבה ל-Administration, ‏Contents, ‏Environments ו-Variables, שנשמר ב-`$env:GITHUB_TOKEN` בלבד.
2. **פרויקט GCP:** יוצרים פרויקט ומקשרים חיוב. עלות משוערת של dev: כ-280 עד 330 דולר בחודש (Cloud SQL כ-100 עד 120, ה-worker כ-115 עד 130, ה-web כ-60). מומלץ להגדיר התראת תקציב.
3. **Bootstrap:** ‏`terraform apply` ב-`infra/bootstrap` יוצר את דלי ה-state.
4. **Apply ל-dev:** ממלאים ב-`terraform.tfvars` את `project_id`, ‏`business_number` (מספר בדיקה) ו-`alert_email`. אחרי `init` מריצים שלושה מעברים: מאגר האימג'ים ודחיפת אימג' בתג `bootstrap`; בסיס הנתונים, הסודות ומשימת המיגרציה, והרצתה; ואז כל השאר. בערך 30 עד 45 דקות, רובן Cloud SQL. שלושה מעברים כי Cloud Run לא יוצר שירות מאימג' שלא קיים (deployment.md תוקן בהתאם).
5. **ב-GitHub:** ענף `dev` מוגן (רק PR עם `check` ירוק), סביבה `dev` עם ארבעה משתנים, והמשתנה `POSTLY_DEPLOY_DEV`.
6. **פריסה ראשונה:** מיזוג PR ל-`dev`, או הרצה ידנית של Deploy עם `image_tag`. משימת המיגרציה רצה לפני כל עדכון. כ-10 עד 15 דקות.
7. **מה רואים:** כתובת `run.app` של `postly-dev-web`, ‏`/healthz` מחזיר `{"ok":true}`. הקונסולה פנימית בלבד ונגישה רק דרך bastion ב-VPC, שעוד לא קיים ב-Terraform. הלוגים נמצאים ב-Logs Explorer ונשמרים 7 ימים. WhatsApp, ‏Instagram ותשלומים הם סימולטורים בלבד עד WP-41. ארגז החול של dev ‏(WP-51) יוסיף דרך להשתמש ב-dev ידנית, למשל צ'אט ארגז חול. התראות במייל: בדיקת בריאות, 5xx, שורות שגיאה, ו-CPU או דיסק של Cloud SQL.
8. **תקלות נפוצות:** API שעוד לא הופעל (מחכים ומריצים שוב), חיוב לא מקושר, השהיית IAM, אימג' חסר, שירות לא בריא לפני המיגרציה, ו-job שמסומן skipped.
9. **פירוק:** `terraform destroy`, ולעצירת כל החיובים גם `gcloud projects delete`. אם משאירים את dev פועל, הוא עולה כ-280 עד 330 דולר בחודש.
