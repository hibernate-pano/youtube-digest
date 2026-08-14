-- YouTube Digest sync schema (Neon / PostgreSQL).
-- Every learner-owned row carries user_id and every API path scopes by the
-- authenticated GitHub user; client-supplied user ids are never trusted.

create table if not exists users (
  id bigserial primary key,
  github_id bigint not null unique,
  github_login text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references users(id) on delete cascade,
  client_id text not null,
  video_id text not null,
  video_title text not null default '',
  channel_name text not null default '',
  timestamp_seconds integer not null,
  quote text not null default '',
  note text not null,
  starred boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_id)
);
create index if not exists notes_user_updated_idx on notes (user_id, updated_at);
create index if not exists notes_user_client_idx on notes (user_id, client_id);

create table if not exists vocabulary (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references users(id) on delete cascade,
  term text not null,
  translation text not null default '',
  sentence text not null default '',
  sentence_translation text not null default '',
  video_id text not null default '',
  video_title text not null default '',
  timestamp_seconds integer not null default 0,
  status text not null default 'learning'
    check (status in ('learning', 'reviewing', 'mastered')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, term, sentence)
);
create index if not exists vocabulary_user_updated_idx on vocabulary (user_id, updated_at);

create table if not exists review_items (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references users(id) on delete cascade,
  vocabulary_id uuid not null references vocabulary(id) on delete cascade,
  due_at timestamptz not null default now(),
  interval_days integer not null default 0,
  ease real not null default 2.5,
  reps integer not null default 0,
  lapses integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (user_id, vocabulary_id)
);
create index if not exists review_due_idx on review_items (user_id, due_at);
