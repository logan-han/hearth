DELETE FROM "automations" WHERE "kind" IS NOT NULL;--> statement-breakpoint
DELETE FROM "secrets" WHERE "key" IN ('TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'ALLOWED_TELEGRAM_IDS', 'AMBIENT_MODE', 'ASSISTANT_PERSONA');--> statement-breakpoint
DELETE FROM "settings" WHERE "key" = 'memory_sweep_day' OR "key" LIKE 'proactive_posts:%' OR "key" LIKE 'unaccounted:%' OR "key" LIKE 'turn:%' OR "key" LIKE 'turnq:%' OR "key" LIKE 'album:%' OR ("key" LIKE 'mail_cursor:%' AND "key" NOT LIKE 'mail_cursor:auto:%');--> statement-breakpoint
ALTER TABLE "chats" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "chats" CASCADE;--> statement-breakpoint
DROP TABLE "messages" CASCADE;--> statement-breakpoint
DROP INDEX "activity_chat_idx";--> statement-breakpoint
DROP INDEX "automations_chat_kind_idx";--> statement-breakpoint
DROP INDEX "email_drafts_chat_status_idx";--> statement-breakpoint
DROP INDEX "members_telegram_user_id_idx";--> statement-breakpoint
DROP INDEX "members_mcp_token_idx";--> statement-breakpoint
CREATE INDEX "activity_member_idx" ON "activity" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE INDEX "email_drafts_member_status_idx" ON "email_drafts" USING btree ("member_id","status");--> statement-breakpoint
ALTER TABLE "activity" DROP COLUMN "chat_id";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "chat_id";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "email_drafts" DROP COLUMN "chat_id";--> statement-breakpoint
ALTER TABLE "event_proposals" DROP COLUMN "chat_id";--> statement-breakpoint
ALTER TABLE "goals" DROP COLUMN "chat_id";--> statement-breakpoint
ALTER TABLE "helpers" DROP COLUMN "groups";--> statement-breakpoint
ALTER TABLE "members" DROP COLUMN "telegram_user_id";--> statement-breakpoint
ALTER TABLE "members" DROP COLUMN "mcp_token_hash";--> statement-breakpoint
ALTER TABLE "members" DROP COLUMN "mcp_token_at";