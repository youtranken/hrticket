ALTER TABLE "reply_templates" ADD COLUMN "category_id" integer;--> statement-breakpoint
ALTER TABLE "reply_templates" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_templates" ADD CONSTRAINT "reply_templates_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reply_templates_category" ON "reply_templates" USING btree ("project_id","category_id");