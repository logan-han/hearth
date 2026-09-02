ALTER TABLE "chats" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "summary_through" integer;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "summary_at" timestamp with time zone;