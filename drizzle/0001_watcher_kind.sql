ALTER TABLE "automations" ADD COLUMN "kind" text;--> statement-breakpoint
UPDATE "automations" SET "kind" = 'money' WHERE "kind" IS NULL AND "label" = '2Up transactions';--> statement-breakpoint
UPDATE "automations" SET "kind" = 'inbox' WHERE "kind" IS NULL AND ("label" = 'Inbox sweep' OR "label" = 'Family inbox sweep' OR "label" LIKE '%''s inbox');--> statement-breakpoint
UPDATE "automations" SET "kind" = 'morning' WHERE "kind" IS NULL AND "label" = 'Morning brief';
