-- Tinaney-Silo — survey silo content schema (starter template).
--
-- Run this on YOUR OWN Supabase project (the silo). Tinaney respondents arrive
-- with a token whose `sub` is their Tinaney user id and `app_metadata.silo_role`
-- is 'owner' (you, the researcher) or 'respondent'. RLS below keys on both, with
-- no shadow users.
--
-- The whole point (BYOI): survey RESPONSES and ANSWERS live only here, on your
-- Supabase. Tinaney never stores them — it only holds a public projection of a
-- published survey (title/description/question count) so people can discover it,
-- then their browser talks to THIS silo directly to take the survey.
--
-- Content model (no complicated levels):
--   status          : 'draft' | 'active' | 'closed'   (respondents take 'active' only)
--   publish_to_hub  : bool (default true)   (projected to the Tinaney Hub catalog
--                                            when active — see sync-to-hub)
--
-- Owner check: the minted token carries app_metadata.silo_role.
-- (auth.jwt() -> 'app_metadata' ->> 'silo_role') = 'owner'

-- ---------------------------------------------------------------------------
-- Tables. Titles/labels are i18n JSON ({ "en": "...", "kh": "..." }) to match
-- how Tinaney stores multilingual survey copy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.surveys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title jsonb NOT NULL DEFAULT '{}'::jsonb,           -- { "en": "...", "kh": "..." }
  description jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  publish_to_hub boolean NOT NULL DEFAULT true,
  max_responses integer,                              -- null = unlimited
  reward_note text,                                   -- free-text incentive shown to respondents
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Questions. Types + `config` mirror Tinaney's survey builder, so a survey built
-- in Tinaney drops straight onto a silo:
--   question_type : 'TEXT' | 'MULTIPLE_CHOICE' (single) | 'CHECKBOX' (multi)
--                 | 'RATING' | 'DATE' | 'MATRIX' | 'GEO_LOCATION' | 'IMAGE_UPLOAD' | 'RANKING'
--   config        : { options: [{ id, label: { en, kh } }], required, min, max, step,
--                     rows/columns (MATRIX), labels, media_url (image on your own R2) }
-- question_type is free text (no CHECK) so new builder types keep working here.
CREATE TABLE IF NOT EXISTS public.survey_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id uuid NOT NULL REFERENCES public.surveys(id) ON DELETE CASCADE,
  order_index integer NOT NULL DEFAULT 0,
  question_type text NOT NULL,   -- see the type list above (Tinaney builder types)
  question_text jsonb NOT NULL DEFAULT '{}'::jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One respondent's attempt at a survey. respondent_uid = the visiting Tinaney
-- user id (token sub); it is set server-side (see set_response_defaults) so a
-- client can never forge it.
CREATE TABLE IF NOT EXISTS public.survey_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id uuid NOT NULL REFERENCES public.surveys(id) ON DELETE CASCADE,
  respondent_uid uuid NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- The actual answers — the data you own. answer_value is JSON so any question
-- type fits (a string, a number, an array of options, an { url } for an image).
CREATE TABLE IF NOT EXISTS public.survey_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL REFERENCES public.survey_responses(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.survey_questions(id) ON DELETE CASCADE,
  answer_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_survey_questions_survey ON public.survey_questions (survey_id, order_index);
CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON public.survey_responses (survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_respondent ON public.survey_responses (respondent_uid);
CREATE INDEX IF NOT EXISTS idx_survey_answers_response ON public.survey_answers (response_id);

-- ---------------------------------------------------------------------------
-- Keep surveys.updated_at fresh.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_surveys_touch ON public.surveys;
CREATE TRIGGER trg_surveys_touch BEFORE UPDATE ON public.surveys
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Anti-tamper: set respondent + validate the survey server-side. A client can
-- only start a response on an OPEN survey, always as itself, and never past the
-- owner's response quota.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_response_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  s record;
  n integer;
BEGIN
  NEW.respondent_uid := auth.uid();
  SELECT status, max_responses INTO s FROM public.surveys WHERE id = NEW.survey_id;
  IF s.status IS NULL OR s.status <> 'active' THEN
    RAISE EXCEPTION 'Survey not open for responses';
  END IF;
  IF s.max_responses IS NOT NULL THEN
    SELECT count(*) INTO n FROM public.survey_responses
      WHERE survey_id = NEW.survey_id AND status = 'completed';
    IF n >= s.max_responses THEN
      RAISE EXCEPTION 'Response quota reached';
    END IF;
  END IF;
  NEW.status := 'in_progress';
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_set_response_defaults ON public.survey_responses;
CREATE TRIGGER trg_set_response_defaults BEFORE INSERT ON public.survey_responses
  FOR EACH ROW EXECUTE FUNCTION public.set_response_defaults();

-- ---------------------------------------------------------------------------
-- RLS. Respondents take ACTIVE surveys and see ONLY their own response data;
-- the owner (Survey Studio) reads/writes everything. Tinaney the Hub reads
-- nothing here — it never has a token for this project.
-- ---------------------------------------------------------------------------
ALTER TABLE public.surveys          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_answers   ENABLE ROW LEVEL SECURITY;

-- Surveys: respondents read active; owner does everything.
DROP POLICY IF EXISTS "read active surveys" ON public.surveys;
DROP POLICY IF EXISTS "owner surveys"       ON public.surveys;
CREATE POLICY "read active surveys" ON public.surveys FOR SELECT USING (status = 'active');
CREATE POLICY "owner surveys" ON public.surveys FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'silo_role') = 'owner')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'silo_role') = 'owner');

-- Questions: readable when their survey is active; owner does everything.
DROP POLICY IF EXISTS "read active questions" ON public.survey_questions;
DROP POLICY IF EXISTS "owner questions"       ON public.survey_questions;
CREATE POLICY "read active questions" ON public.survey_questions FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.surveys s WHERE s.id = survey_id AND s.status = 'active'));
CREATE POLICY "owner questions" ON public.survey_questions FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'silo_role') = 'owner')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'silo_role') = 'owner');

-- Responses: a respondent starts + reads + finishes only their own; the owner
-- reads/manages all. respondent_uid is forced server-side by the trigger.
DROP POLICY IF EXISTS "respondent creates response" ON public.survey_responses;
DROP POLICY IF EXISTS "read own or owner response"  ON public.survey_responses;
DROP POLICY IF EXISTS "update own or owner response" ON public.survey_responses;
DROP POLICY IF EXISTS "owner deletes response"      ON public.survey_responses;
CREATE POLICY "respondent creates response" ON public.survey_responses
  FOR INSERT WITH CHECK (respondent_uid = auth.uid());
CREATE POLICY "read own or owner response" ON public.survey_responses
  FOR SELECT USING (
    respondent_uid = auth.uid()
    OR (auth.jwt() -> 'app_metadata' ->> 'silo_role') = 'owner'
  );
CREATE POLICY "update own or owner response" ON public.survey_responses
  FOR UPDATE USING (
    respondent_uid = auth.uid()
    OR (auth.jwt() -> 'app_metadata' ->> 'silo_role') = 'owner'
  );
CREATE POLICY "owner deletes response" ON public.survey_responses
  FOR DELETE USING ((auth.jwt() -> 'app_metadata' ->> 'silo_role') = 'owner');

-- Answers: a respondent writes/reads answers only on their OWN response; the
-- owner reads/manages all.
DROP POLICY IF EXISTS "write own answer"       ON public.survey_answers;
DROP POLICY IF EXISTS "read own or owner answer" ON public.survey_answers;
DROP POLICY IF EXISTS "owner manages answers"  ON public.survey_answers;
CREATE POLICY "write own answer" ON public.survey_answers
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.survey_responses r
    WHERE r.id = response_id AND r.respondent_uid = auth.uid() AND r.status = 'in_progress'
  ));
CREATE POLICY "read own or owner answer" ON public.survey_answers
  FOR SELECT USING (
    (auth.jwt() -> 'app_metadata' ->> 'silo_role') = 'owner'
    OR EXISTS (SELECT 1 FROM public.survey_responses r WHERE r.id = response_id AND r.respondent_uid = auth.uid())
  );
CREATE POLICY "owner manages answers" ON public.survey_answers
  FOR ALL USING ((auth.jwt() -> 'app_metadata' ->> 'silo_role') = 'owner')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'silo_role') = 'owner');
