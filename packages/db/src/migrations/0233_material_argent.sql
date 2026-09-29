CREATE TABLE "pipeline_case_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"producer_plugin_id" uuid NOT NULL,
	"producer_plugin_key" text NOT NULL,
	"turn" integer DEFAULT 0 NOT NULL,
	"role" text DEFAULT 'waiting' NOT NULL,
	"agent_id" uuid,
	"revision_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_case_work_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"turn" integer NOT NULL,
	"role" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"revision_id" text NOT NULL,
	"content_digest" text NOT NULL,
	"result" jsonb NOT NULL,
	"result_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_case_work_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"turn" integer NOT NULL,
	"request_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"role" text NOT NULL,
	"agent_id" uuid,
	"revision_id" text,
	"prior_result_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_case_work" ADD CONSTRAINT "pipeline_case_work_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_work" ADD CONSTRAINT "pipeline_case_work_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_work" ADD CONSTRAINT "pipeline_case_work_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_work" ADD CONSTRAINT "pipeline_case_work_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_work_results" ADD CONSTRAINT "pipeline_case_work_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_work_results" ADD CONSTRAINT "pipeline_case_work_results_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_work_results" ADD CONSTRAINT "pipeline_case_work_results_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_work_turns" ADD CONSTRAINT "pipeline_case_work_turns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_work_turns" ADD CONSTRAINT "pipeline_case_work_turns_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_work_turns" ADD CONSTRAINT "pipeline_case_work_turns_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_work_turns" ADD CONSTRAINT "pipeline_case_work_turns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_work_case_uq" ON "pipeline_case_work" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_work_issue_uq" ON "pipeline_case_work" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "pipeline_case_work_company_idx" ON "pipeline_case_work" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_work_result_uq" ON "pipeline_case_work_results" USING btree ("case_id","turn");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_work_turn_uq" ON "pipeline_case_work_turns" USING btree ("case_id","turn");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_work_request_uq" ON "pipeline_case_work_turns" USING btree ("case_id","request_key");