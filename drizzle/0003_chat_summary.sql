ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "summary" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "summary_through" integer;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "summary_at" timestamp with time zone;