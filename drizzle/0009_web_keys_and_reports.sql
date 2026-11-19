CREATE TABLE "automation_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL,
	"automation_id" integer,
	"label" text NOT NULL,
	"helper" text,
	"status" text NOT NULL,
	"body" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "automation_reports" ADD CONSTRAINT "automation_reports_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_reports" ADD CONSTRAINT "automation_reports_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_keys" ADD CONSTRAINT "mcp_keys_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_reports_member_idx" ON "automation_reports" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_keys_token_hash_idx" ON "mcp_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_keys_member_idx" ON "mcp_keys" USING btree ("member_id");--> statement-breakpoint
INSERT INTO "mcp_keys" ("member_id", "label", "token_hash", "created_at") SELECT "id", 'Key from before keys were made on the web', "mcp_token_hash", coalesce("mcp_token_at", now()) FROM "members" WHERE "mcp_token_hash" IS NOT NULL;