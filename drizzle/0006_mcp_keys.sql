ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "mcp_token_hash" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "mcp_token_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "members_mcp_token_idx" ON "members" USING btree ("mcp_token_hash");