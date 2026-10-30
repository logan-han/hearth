CREATE TABLE "activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"member_id" integer,
	"via" text NOT NULL,
	"tool" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"goal_id" integer NOT NULL,
	"content" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"goal_id" integer NOT NULL,
	"member_id" integer,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"member_id" integer,
	"title" text NOT NULL,
	"outcome" text,
	"target_date" text,
	"automation_id" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "helpers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"groups" text DEFAULT '[]' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"steps" text NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "repeat" text DEFAULT 'always' NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "helper_id" integer;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "read_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_steps" ADD CONSTRAINT "goal_steps_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_updates" ADD CONSTRAINT "goal_updates_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_updates" ADD CONSTRAINT "goal_updates_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpers" ADD CONSTRAINT "helpers_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "activity" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "activity_chat_idx" ON "activity" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "goal_steps_goal_idx" ON "goal_steps" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "goal_updates_goal_idx" ON "goal_updates" USING btree ("goal_id","created_at");--> statement-breakpoint
CREATE INDEX "goals_status_idx" ON "goals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "helpers_name_idx" ON "helpers" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "routines_name_idx" ON "routines" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_helper_id_helpers_id_fk" FOREIGN KEY ("helper_id") REFERENCES "public"."helpers"("id") ON DELETE set null ON UPDATE no action;