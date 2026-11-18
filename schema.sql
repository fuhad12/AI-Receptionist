-- Run once in the Supabase SQL editor (Dashboard > SQL Editor > New query)

create table if not exists reservations (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  vapi_call_id text,
  guest_name text not null,
  phone text not null,
  guests int not null check (guests between 1 and 50),
  reserve_date date not null,
  reserve_time text not null,
  notes text,
  created_at timestamptz default now(),
  -- stops the same booking being saved twice if the AI retries a tool call
  unique (vapi_call_id, reserve_date, reserve_time, guest_name)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  vapi_call_id text,
  caller_name text,
  phone text not null,
  message text not null,
  created_at timestamptz default now()
);

create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  business_slug text not null,
  vapi_call_id text unique,
  summary text,
  transcript text,
  recording_url text,
  duration_seconds int,
  ended_reason text,
  created_at timestamptz default now()
);

create index if not exists reservations_created on reservations (created_at desc);
create index if not exists messages_created on messages (created_at desc);
create index if not exists calls_created on calls (created_at desc);

-- Lock the tables down. The server uses the service_role key, which bypasses RLS.
alter table reservations enable row level security;
alter table messages enable row level security;
alter table calls enable row level security;
