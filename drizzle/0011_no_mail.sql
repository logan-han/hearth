DELETE FROM "settings" WHERE "key" LIKE 'mail_cursor:%' OR "key" LIKE 'unspent:%';--> statement-breakpoint
DROP TABLE "email_drafts" CASCADE;
