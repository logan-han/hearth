ALTER TABLE "members" ADD COLUMN "mcp_token_hash" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "mcp_token_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "members_mcp_token_idx" ON "members" USING btree ("mcp_token_hash");