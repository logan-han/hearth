CREATE TABLE "model_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"slot" text NOT NULL,
	"purpose" text NOT NULL,
	"outcome" text NOT NULL,
	"ms" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "model_events_created_idx" ON "model_events" USING btree ("created_at");