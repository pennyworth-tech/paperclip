CREATE TABLE "pipeline_stage_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"producer_plugin_id" uuid NOT NULL,
	"producer_plugin_key" text NOT NULL,
	"kind" text NOT NULL,
	"request_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"case_version" integer NOT NULL,
	"policy_digest" text NOT NULL,
	"revision_id" text NOT NULL,
	"content_digest" text NOT NULL,
	"document_pins" jsonb NOT NULL,
	"prerequisite_decision_ids" jsonb NOT NULL,
	"readiness" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD COLUMN "blocking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD COLUMN "source_locator" jsonb;--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD COLUMN "resolution_disposition" text;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN "stage_evidence_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_stage_evidence" ADD CONSTRAINT "pipeline_stage_evidence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stage_evidence" ADD CONSTRAINT "pipeline_stage_evidence_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stage_evidence" ADD CONSTRAINT "pipeline_stage_evidence_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_stage_evidence_case_created_idx" ON "pipeline_stage_evidence" USING btree ("company_id","case_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stage_evidence_request_uq" ON "pipeline_stage_evidence" USING btree ("company_id","case_id","producer_plugin_id","request_key");