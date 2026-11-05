-- Hand-written (T1 follow-up, review of PR #69): a payment link that fails to send after
-- activation opens a console item (technical-design.md, Billing).
ALTER TYPE "public"."console_item_kind" ADD VALUE 'payment_link_failed';
