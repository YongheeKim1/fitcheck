-- 핏체크 서버 스키마 (Supabase / Postgres)
-- Supabase 대시보드 → SQL Editor에 이 파일 전체를 붙여 넣고 실행한다. 여러 번 실행해도 된다.
--
-- 설계
--   * 계정은 Supabase Auth가 아니라 이 앱이 직접 관리한다(아이디·비밀번호·이름).
--   * 비밀번호는 bcrypt 해시로만 저장한다.
--   * 모든 테이블은 RLS로 잠그고 정책을 두지 않는다 → 브라우저(anon 키)는 테이블을 직접 읽거나 쓸 수 없다.
--   * 브라우저는 아래 fc_* 함수만 호출할 수 있고, 함수가 세션 토큰으로 본인 데이터만 다룬다.
--   * 사진은 저장하지 않는다. 치수·옷·분석 결과(숫자)만 저장한다.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- 테이블 ----------
create table if not exists public.fc_users (
  id            uuid primary key default gen_random_uuid(),
  login_id      text not null unique,
  name          text not null,
  password_hash text not null,
  failed_count  int not null default 0,
  locked_until  timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists public.fc_sessions (
  token_hash  text primary key,            -- 토큰 원문은 저장하지 않는다(sha256)
  user_id     uuid not null references public.fc_users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists fc_sessions_user on public.fc_sessions(user_id);

-- 체형·분석 결과·작성 중인 사이즈표 (사용자당 한 줄)
create table if not exists public.fc_profiles (
  user_id        uuid primary key references public.fc_users(id) on delete cascade,
  body           jsonb not null default '{}',
  body_analysis  jsonb,
  personal_color jsonb,
  draft          jsonb,
  updated_at     bigint not null default 0     -- 기기에서 고친 시각(ms). 더 최근 것이 이긴다
);

-- 내 옷 (옷 하나 = 한 줄). 지운 옷은 deleted = true로 남겨 다른 기기에도 삭제가 전달되게 한다
create table if not exists public.fc_closet_items (
  user_id    uuid not null references public.fc_users(id) on delete cascade,
  id         text not null,                     -- 기기에서 만든 id
  item       jsonb not null default '{}',       -- 종류·이름·사이즈·실측 등
  deleted    boolean not null default false,
  updated_at bigint not null default 0,
  primary key (user_id, id)
);

-- 가입 코드는 쓰지 않는다(누구나 가입 가능). 예전 버전에서 만든 설정 테이블은 지운다
drop table if exists public.fc_config;

alter table public.fc_users        enable row level security;
alter table public.fc_sessions     enable row level security;
alter table public.fc_profiles     enable row level security;
alter table public.fc_closet_items enable row level security;
revoke all on public.fc_users, public.fc_sessions, public.fc_profiles, public.fc_closet_items from anon, authenticated;

-- ---------- 내부 함수 ----------
-- 세션 토큰 → 사용자 id. 없거나 만료면 오류
create or replace function public.fc_auth(p_token text)
returns uuid
language plpgsql security definer set search_path = public, extensions
as $$
declare v_user uuid;
begin
  select user_id into v_user from fc_sessions
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') and expires_at > now();
  if v_user is null then
    raise exception 'FC_AUTH: 로그인이 만료됐어요. 다시 로그인해 주세요.';
  end if;
  -- 쓰는 동안은 만료를 90일 뒤로 늘린다
  update fc_sessions set expires_at = now() + interval '90 days'
   where token_hash = encode(digest(p_token, 'sha256'), 'hex') and expires_at < now() + interval '60 days';
  return v_user;
end $$;

create or replace function public.fc_new_session(p_user uuid)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare v_token text := encode(gen_random_bytes(32), 'hex');
begin
  insert into fc_sessions(token_hash, user_id, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), p_user, now() + interval '90 days');
  delete from fc_sessions where user_id = p_user and expires_at < now();
  return v_token;
end $$;

-- ---------- 공개 함수(브라우저가 호출) ----------
drop function if exists public.fc_signup(text, text, text, text); -- 예전 버전(가입 코드 인자 있음)

create or replace function public.fc_signup(p_login text, p_password text, p_name text)
returns json
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_login text := lower(trim(p_login));
  v_user  uuid;
begin
  if v_login !~ '^[a-z0-9_.-]{3,30}$' then
    raise exception 'FC_INPUT: 아이디는 영문 소문자·숫자·_.- 로 3~30자예요.';
  end if;
  if length(coalesce(p_password, '')) < 8 or length(p_password) > 72 then
    raise exception 'FC_INPUT: 비밀번호는 8~72자로 해 주세요.';
  end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 30 then
    raise exception 'FC_INPUT: 이름은 1~30자로 해 주세요.';
  end if;
  if exists (select 1 from fc_users where login_id = v_login) then
    raise exception 'FC_INPUT: 이미 쓰고 있는 아이디예요.';
  end if;
  insert into fc_users(login_id, name, password_hash)
  values (v_login, trim(p_name), crypt(p_password, gen_salt('bf', 10)))
  returning id into v_user;
  return json_build_object('token', fc_new_session(v_user), 'login', v_login, 'name', trim(p_name));
end $$;

-- 실패는 예외 대신 {error}로 돌려준다: 예외를 던지면 트랜잭션이 되돌려져 실패 횟수가 쌓이지 않기 때문
create or replace function public.fc_login(p_login text, p_password text)
returns json
language plpgsql security definer set search_path = public, extensions
as $$
declare u fc_users;
begin
  select * into u from fc_users where login_id = lower(trim(p_login));
  if u.id is null then
    -- 없는 아이디도 같은 시간이 걸리게 해서 아이디 존재 여부를 알 수 없게 한다
    perform crypt(coalesce(p_password, ''), gen_salt('bf', 10));
    return json_build_object('error', 'FC_LOGIN: 아이디 또는 비밀번호가 맞지 않아요.');
  end if;
  if u.locked_until is not null and u.locked_until > now() then
    return json_build_object('error', 'FC_LOCKED: 로그인을 여러 번 틀려서 잠시 잠겼어요. 10분 뒤에 다시 시도해 주세요.');
  end if;
  if u.password_hash <> crypt(coalesce(p_password, ''), u.password_hash) then
    update fc_users set failed_count = failed_count + 1,
      locked_until = case when failed_count + 1 >= 5 then now() + interval '10 minutes' else null end
     where id = u.id;
    return json_build_object('error', 'FC_LOGIN: 아이디 또는 비밀번호가 맞지 않아요.');
  end if;
  update fc_users set failed_count = 0, locked_until = null where id = u.id;
  return json_build_object('token', fc_new_session(u.id), 'login', u.login_id, 'name', u.name);
end $$;

create or replace function public.fc_logout(p_token text)
returns void
language sql security definer set search_path = public, extensions
as $$
  delete from fc_sessions where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;

-- 내 데이터 전체(지운 옷 표시 포함)
create or replace function public.fc_pull(p_token text)
returns json
language plpgsql security definer set search_path = public, extensions
as $$
declare v_user uuid := fc_auth(p_token);
begin
  return json_build_object(
    'profile', (select json_build_object('body', body, 'bodyAnalysis', body_analysis, 'personalColor', personal_color,
                                         'draft', draft, 'updatedAt', updated_at)
                  from fc_profiles where user_id = v_user),
    'items', coalesce((select json_agg(json_build_object('id', id, 'item', item, 'deleted', deleted, 'updatedAt', updated_at))
                         from fc_closet_items where user_id = v_user), '[]'::json),
    'user', (select json_build_object('login', login_id, 'name', name) from fc_users where id = v_user)
  );
end $$;

-- 기기의 변경 사항 올리기: 프로필과 옷 하나하나 모두 "더 최근(updatedAt) 것이 이긴다"
create or replace function public.fc_push(p_token text, p_profile jsonb, p_items jsonb)
returns json
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_user uuid := fc_auth(p_token);
  e jsonb;
begin
  if pg_column_size(p_profile) + pg_column_size(p_items) > 1000000 then
    raise exception 'FC_INPUT: 데이터가 너무 커요.';
  end if;
  if jsonb_array_length(coalesce(p_items, '[]')) > 1000 then
    raise exception 'FC_INPUT: 옷이 너무 많아요.';
  end if;

  if p_profile is not null then
    insert into fc_profiles as t (user_id, body, body_analysis, personal_color, draft, updated_at)
    values (v_user, coalesce(p_profile->'body', '{}'), p_profile->'bodyAnalysis', p_profile->'personalColor',
            p_profile->'draft', coalesce((p_profile->>'updatedAt')::bigint, 0))
    on conflict (user_id) do update
       set body = excluded.body, body_analysis = excluded.body_analysis, personal_color = excluded.personal_color,
           draft = excluded.draft, updated_at = excluded.updated_at
     where t.updated_at < excluded.updated_at;
  end if;

  for e in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    if coalesce(e->>'id', '') = '' or length(e->>'id') > 64 then continue; end if;
    insert into fc_closet_items as t (user_id, id, item, deleted, updated_at)
    values (v_user, e->>'id', coalesce(e->'item', '{}'), coalesce((e->>'deleted')::boolean, false),
            coalesce((e->>'updatedAt')::bigint, 0))
    on conflict (user_id, id) do update
       set item = excluded.item, deleted = excluded.deleted, updated_at = excluded.updated_at
     where t.updated_at < excluded.updated_at;
  end loop;

  return fc_pull(p_token);
end $$;

-- 계정 삭제(비밀번호 확인). 모든 데이터가 함께 지워진다
create or replace function public.fc_delete_account(p_token text, p_password text)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare v_user uuid := fc_auth(p_token); v_hash text;
begin
  select password_hash into v_hash from fc_users where id = v_user;
  if v_hash <> crypt(coalesce(p_password, ''), v_hash) then
    raise exception 'FC_LOGIN: 비밀번호가 맞지 않아요.';
  end if;
  delete from fc_users where id = v_user;
end $$;

-- ---------- 권한: 브라우저는 공개 함수만 ----------
revoke execute on function public.fc_auth(text), public.fc_new_session(uuid) from public, anon, authenticated;
grant execute on function
  public.fc_signup(text, text, text), public.fc_login(text, text), public.fc_logout(text),
  public.fc_pull(text), public.fc_push(text, jsonb, jsonb), public.fc_delete_account(text, text)
  to anon, authenticated;
