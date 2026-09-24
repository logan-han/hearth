ALTER TABLE "chats" ADD COLUMN "left_at" timestamp with time zone;--> statement-breakpoint
DELETE FROM "automations" WHERE "kind" IS NOT NULL AND "id" NOT IN (SELECT DISTINCT ON ("chat_id", "kind") "id" FROM "automations" WHERE "kind" IS NOT NULL ORDER BY "chat_id", "kind", "enabled" DESC, "id");--> statement-breakpoint
CREATE UNIQUE INDEX "automations_chat_kind_idx" ON "automations" USING btree ("chat_id","kind") WHERE "automations"."kind" is not null;
