-- V2013: provider-defined customer financing forms.
-- Providers define requirements; ELEMARKET renders and securely transports answers.
-- No provider can read another provider's submission.

create table if not exists financing_provider_forms (
  id text primary key,
  provider_id text not null references financing_providers(id) on delete cascade,
  title text not null check(char_length(title) between 2 and 160),
  description text,
  version integer not null default 1 check(version > 0),
  status text not null default 'draft' check(status in ('draft','active','archived')),
  created_by_user_id text,
  published_by_user_id text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists financing_provider_one_active_form_uq
  on financing_provider_forms(provider_id) where status='active';

create table if not exists financing_provider_form_fields (
  id text primary key,
  form_id text not null references financing_provider_forms(id) on delete cascade,
  field_key text not null check(field_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  label text not null check(char_length(label) between 2 and 160),
  field_type text not null check(field_type in (
    'text','textarea','email','phone','number','select','checkbox',
    'ghana_card_number','ghana_card_front','ghana_card_back','selfie','document'
  )),
  required boolean not null default false,
  help_text text,
  options jsonb not null default '[]'::jsonb check(jsonb_typeof(options)='array'),
  max_length integer check(max_length is null or max_length between 1 and 4000),
  sort_order integer not null default 0 check(sort_order between 0 and 1000),
  created_at timestamptz not null default now(),
  unique(form_id,field_key)
);
create index if not exists financing_form_fields_order_idx
  on financing_provider_form_fields(form_id,sort_order,id);

create table if not exists financing_application_form_submissions (
  id text primary key,
  application_id text not null references customer_financing_applications(id) on delete cascade,
  provider_id text not null references financing_providers(id),
  form_id text not null references financing_provider_forms(id),
  form_version integer not null,
  submitted_by_user_id text not null,
  submitted_at timestamptz not null default now(),
  unique(application_id)
);
create index if not exists financing_form_submission_provider_idx
  on financing_application_form_submissions(provider_id,submitted_at desc);

create table if not exists financing_application_form_answers (
  id text primary key,
  submission_id text not null references financing_application_form_submissions(id) on delete cascade,
  field_id text not null references financing_provider_form_fields(id),
  field_key text not null,
  field_type text not null,
  answer_text text,
  upload_intent_id text references storage_upload_intents(id),
  storage_reference text,
  content_type text,
  created_at timestamptz not null default now(),
  check((upload_intent_id is null and storage_reference is null) or
        (upload_intent_id is not null and storage_reference is not null)),
  unique(submission_id,field_id)
);
create index if not exists financing_form_answers_submission_idx
  on financing_application_form_answers(submission_id);
create unique index if not exists financing_form_answer_upload_intent_uq
  on financing_application_form_answers(upload_intent_id) where upload_intent_id is not null;

comment on table financing_provider_forms is
  'Provider-authored application requirements rendered by ELEMARKET. The provider, not ELEMARKET, determines underwriting information requested.';
comment on table financing_application_form_answers is
  'Provider-scoped application answers. Sensitive file contents remain in object storage; rows hold verified references only.';
