CREATE TABLE IF NOT EXISTS "memory_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"candidate" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"asked_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"outcome" text,
	"memory_id" integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_questions_settled_idx" ON "memory_questions" USING btree ("settled_at");