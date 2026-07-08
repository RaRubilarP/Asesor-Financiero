-- ============================================================================
-- Esquema de base de datos para "Asesor de Portafolio" (versión ligera:
-- HTML estático + Supabase, sin Next.js/Vercel).
-- Ejecutar en el SQL editor de tu proyecto de Supabase (una sola vez).
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. POSICIONES DEL PORTAFOLIO (una fila por acción/ETF que tiene el usuario)
-- ----------------------------------------------------------------------------
create table if not exists public.positions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ticker       text not null,
  name         text,
  asset_type   text not null check (asset_type in ('stock','etf')),
  invested_usd numeric(14,2) not null default 0,
  gain_pct     numeric(8,4) not null default 0,
  source       text not null default 'manual', -- 'manual' | 'image-upload'
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, ticker)
);

alter table public.positions enable row level security;

create policy "positions_select_own" on public.positions
  for select using (auth.uid() = user_id);
create policy "positions_insert_own" on public.positions
  for insert with check (auth.uid() = user_id);
create policy "positions_update_own" on public.positions
  for update using (auth.uid() = user_id);
create policy "positions_delete_own" on public.positions
  for delete using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 2. PESOS OBJETIVO por usuario y ticker (para el Simulador de aporte)
-- ----------------------------------------------------------------------------
create table if not exists public.target_weights (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ticker      text not null,
  target_pct  numeric(6,2) not null default 0,
  updated_at  timestamptz not null default now(),
  unique (user_id, ticker)
);

alter table public.target_weights enable row level security;

create policy "targets_select_own" on public.target_weights
  for select using (auth.uid() = user_id);
create policy "targets_insert_own" on public.target_weights
  for insert with check (auth.uid() = user_id);
create policy "targets_update_own" on public.target_weights
  for update using (auth.uid() = user_id);
create policy "targets_delete_own" on public.target_weights
  for delete using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 3. CACHÉ DE DATOS DE MERCADO (compartida entre usuarios — datos públicos).
--    A diferencia de la versión Next.js, aquí la Edge Function corre con el
--    JWT del propio usuario (no con la service role key), así que cualquier
--    usuario autenticado puede leer Y escribir esta caché compartida — son
--    datos públicos de mercado, no información privada de nadie.
-- ----------------------------------------------------------------------------
create table if not exists public.market_cache (
  ticker      text primary key,
  asset_type  text not null check (asset_type in ('stock','etf')),
  payload     jsonb not null,
  fetched_at  timestamptz not null default now()
);

alter table public.market_cache enable row level security;

create policy "market_cache_select_authenticated" on public.market_cache
  for select using (auth.role() = 'authenticated');
create policy "market_cache_upsert_authenticated" on public.market_cache
  for insert to authenticated with check (true);
create policy "market_cache_update_authenticated" on public.market_cache
  for update to authenticated using (true) with check (true);

-- ----------------------------------------------------------------------------
-- 4. HISTORIAL DE CARGAS DE IMAGEN (auditoría simple, opcional)
-- ----------------------------------------------------------------------------
create table if not exists public.portfolio_uploads (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  storage_path  text,
  parsed_json   jsonb,
  created_at    timestamptz not null default now()
);

alter table public.portfolio_uploads enable row level security;

create policy "uploads_select_own" on public.portfolio_uploads
  for select using (auth.uid() = user_id);
create policy "uploads_insert_own" on public.portfolio_uploads
  for insert with check (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 5. Trigger para mantener updated_at al día
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_positions_updated_at on public.positions;
create trigger trg_positions_updated_at
  before update on public.positions
  for each row execute function public.set_updated_at();

drop trigger if exists trg_targets_updated_at on public.target_weights;
create trigger trg_targets_updated_at
  before update on public.target_weights
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 6. Storage bucket para las capturas de portafolio subidas por el usuario
--    Crea el bucket "portfolio-uploads" desde el Dashboard de Supabase
--    (Storage → New bucket → nombre "portfolio-uploads" → Privado),
--    y luego en Storage > Policies agrega, para authenticated:
--      SELECT: (auth.uid())::text = (storage.foldername(name))[1]
--      INSERT: (auth.uid())::text = (storage.foldername(name))[1]
--    Esto exige que cada archivo se guarde bajo una carpeta con el uid del
--    usuario, p. ej.  {user_id}/portafolio-2026-07.png
-- ----------------------------------------------------------------------------
