# WhatsApp templates

Every message Postly sends the owner outside WhatsApp's 24-hour customer-service window must be a template that Meta has approved. This file lists each one, so the human can submit them and so code and docs agree. The bodies are copied from the code; the copy is provisional (H6, see [human-review-queue.md](human-review-queue.md)) and a change here goes together with the matching `*-copy.ts` constant.

Variables are named in code (`{{businessName}}`). Meta uses positional placeholders (`{{1}}`, `{{2}}`), so the messaging provider maps the names, in the order listed below, to positions. Each template is submitted in Hebrew (`he`) first; another language is a separate submission under the same name.

## Templates

| Name | Category | Variables (in order) | Sent when | Source |
|---|---|---|---|---|
| `weekly_reminder` | Utility | `businessName` | Monday reminder, when the window is closed | `src/modules/workflow/weekly-copy.ts` |
| `drafts_ready` | Utility | `businessName` | Drafts are ready but the window closed while they were made | `src/modules/workflow/drafts-copy.ts` |
| `publication_confirmation` | Utility | `topic`, `networks` | All publications of a post went live | `src/modules/workflow/schedule-copy.ts` |
| `publication_failed` | Utility | `topic`, `failed` | A publication failed for good | `src/modules/workflow/schedule-copy.ts` |
| `channel_disconnected` | Utility | `networks` | The channel health check finds a lost connection | `src/modules/workflow/schedule-copy.ts` |
| `subscription_cancelled` | Utility | `deleteAfter` | The subscription is cancelled | `src/modules/workflow/cancellation-copy.ts` |
| `monthly_report` | Utility | `month`, `posts`, `reach`, `engagement` | First days of the month, last month's figures | `src/modules/workflow/cancellation-copy.ts` |
| `payment_link` (proposed, T1) | Utility | `businessName`, `link` (URL button) | Onboarding ends and the owner must pay, window closed | not in code yet |
| `payment_failed` (proposed, T1) | Utility | `businessName`, `graceUntil`, `link` (URL button) | Subscription goes `past_due`, and reminders during the grace period | not in code yet |

### Bodies

**weekly_reminder**
> היי {{businessName}}, מה חדש השבוע? שלחו לי עדכון קצר, בטקסט, בהקלטה או בתמונות, ואכין לכם את הפוסטים של השבוע.

**drafts_ready**
> הטיוטות של {{businessName}} לשבוע הזה מוכנות. כתבו לי כל הודעה ואשלח אותן לאישור.

**publication_confirmation**
> הפוסט "{{topic}}" עלה עכשיו ב{{networks}} ✅

**publication_failed**
> לא הצלחנו לפרסם את הפוסט "{{topic}}" ב{{failed}}. הצוות שלנו כבר מטפל בזה ויעדכן אותך.

**channel_disconnected**
> החיבור של Postly ל{{networks}} נותק, ולכן לא נוכל לפרסם שם עד שיחובר מחדש. הצוות שלנו ייצור איתך קשר עם קישור לחיבור.

**subscription_cancelled**
> המנוי שלך ל-Postly בוטל, והחיבור לרשתות החברתיות נותק. הנתונים של העסק יימחקו ב-{{deleteAfter}}. אם זו טעות, כתבו לנו כאן.

**monthly_report**
> הסיכום של Postly ל{{month}}: {{posts}} פוסטים פורסמו, חשיפה {{reach}}, מעורבות {{engagement}} (לייקים, תגובות ושיתופים).

**payment_link** (proposed; final wording comes with T1's docs and code)
> היי {{businessName}}, הכול מוכן לפרסום. כדי להתחיל, אפשר לשלם כאן בקישור המאובטח. אחרי התשלום נתחיל לעבוד.

Button: URL, `Pay` / "לתשלום", dynamic suffix `{{link}}`.

**payment_failed** (proposed; final wording comes with T1's docs and code)
> היי {{businessName}}, התשלום על המנוי ל-Postly לא עבר. הפרסום יימשך עד {{graceUntil}}; אחרי זה נשהה אותו עד שהתשלום יעבור. שום דבר לא יימחק.

Button: URL, "לעדכון אמצעי תשלום", dynamic suffix `{{link}}`.

## Notes on the content

- Every template is **Utility**: it is about the owner's own account, posts or subscription and is never promotional. Meta re-categorises a utility template as Marketing if it contains offers or sales wording, which costs more and needs opt-in; keep that wording out.
- A variable may not start or end the body, and two variables may not sit side by side. `publication_confirmation` ends with an emoji after the variable for that reason. If Meta rejects a body for variable placement, add fixed words around the variable rather than changing the variable.
- Sample values are required at submission. Use realistic ones: `businessName` = "מאפיית שושנה", `topic` = "חלות לשבת", `networks` = "אינסטגרם ופייסבוק", `deleteAfter` = "4 בדצמבר 2026", `month` = "אוקטובר", `posts` = "8", `reach` = "1,240", `engagement` = "96".
- Links go in a URL button with a dynamic suffix, not in the body, so the domain is fixed and reviewable.

## Getting a template approved

1. In Meta Business Manager, open **WhatsApp Manager → Message templates** for the WhatsApp Business Account behind the production number (or the template screen of the BSP chosen behind `MessagingProvider`, which submits to Meta for us).
2. **Create template**: category Utility, name exactly as in the table (lower case, underscores), language Hebrew.
3. Paste the body. Replace each named variable with `{{1}}`, `{{2}}`, ... in the order of the table, and enter the sample values above.
4. Add the URL button where listed (the two billing templates).
5. Submit. Review is usually minutes to a day. A rejection names the reason; fix the wording (not the meaning), update the body here and in the `*-copy.ts` constant in one PR, and resubmit, either under the same name after editing or under a new name with a `_v2` suffix (the name in code then changes too).
6. When approved, tick it in the checklist below in a PR. The dev and stage environments use the simulator and need no approval.

Tips that speed up review: keep each body short and plainly transactional, name the business (Postly) so the message is clearly from the service the owner signed up to, avoid capitals, many emojis or urgent wording, and submit all templates at once after the business is verified, since the number's display name and business verification must already be approved.

## Approval checklist

- [ ] `weekly_reminder`
- [ ] `drafts_ready`
- [ ] `publication_confirmation`
- [ ] `publication_failed`
- [ ] `channel_disconnected`
- [ ] `subscription_cancelled`
- [ ] `monthly_report`
- [ ] `payment_link` (after T1)
- [ ] `payment_failed` (after T1)
