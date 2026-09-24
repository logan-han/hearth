ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "superseded_by" integer;