ALTER TABLE "memories" ADD COLUMN "invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "superseded_by" integer;