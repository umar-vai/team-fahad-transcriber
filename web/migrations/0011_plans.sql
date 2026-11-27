-- Pricing plans shown on the public home page and managed by admins on the Pricing page.
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT,
  -- Prices in the plan's currency. NULL monthly price = "Contact us" (custom price).
  price_monthly REAL,
  price_yearly REAL,
  currency TEXT NOT NULL DEFAULT 'BDT',
  -- Transcription minutes per month. NULL = unlimited.
  minutes_month INTEGER,
  -- Longest single file in minutes. NULL = no limit.
  max_file_minutes INTEGER,
  -- One feature per line, shown as a checklist on the pricing card.
  features TEXT NOT NULL DEFAULT '',
  cta_label TEXT,
  -- 1 = shown as "Most popular".
  highlighted INTEGER NOT NULL DEFAULT 0,
  -- 1 = shown on the public pricing section. Hidden plans can still be given to people.
  is_public INTEGER NOT NULL DEFAULT 1,
  -- 1 = the plan of everyone who has not been given another plan. Exactly one plan has it.
  is_default INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Which plan a person is on. Keyed by email so people can be given a plan before they first sign in.
CREATE TABLE IF NOT EXISTS user_plans (
  email TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  -- Optional end date (ms). After it the person falls back to the default plan.
  expires_at INTEGER,
  note TEXT,
  assigned_by TEXT,
  assigned_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS user_plans_plan ON user_plans(plan_id);

-- Starting plans. Admins can change every value on the Pricing page.
INSERT OR IGNORE INTO plans (id, name, tagline, price_monthly, price_yearly, currency, minutes_month, max_file_minutes, features, cta_label, highlighted, is_public, is_default, sort, created_at, updated_at) VALUES
  ('free', 'Free', 'Try it on your own recordings', 0, 0, 'BDT', 60, 30,
   'Bangla, English, Arabic, Hindi and auto detect
Smart clean and verbatim transcripts
Subtitles with speakers (SRT, VTT)
Word and text downloads
Private history', 'Start free', 0, 1, 1, 10,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('pro', 'Pro', 'For creators, journalists and students', 990, 9900, 'BDT', 1500, 240,
   'Everything in Free
Google Drive folders and YouTube links
Summaries and translations
Shayari mode (Urdu and Hindi)
Long recordings split and run in parallel
Live voice transcription', 'Get Pro', 1, 1, 0, 20,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('team', 'Team', 'For offices, clinics and call centers', 4990, 49900, 'BDT', 10000, NULL,
   'Everything in Pro
Team workspace with managers and viewers
Bridge PCs: new recordings transcribed live
Nightly Google Drive automation
Results in Google Sheets and Notion
Separate team history', 'Get Team', 0, 1, 0, 30,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('enterprise', 'Enterprise', 'Large volumes and custom setups', NULL, NULL, 'BDT', NULL, NULL,
   'Unlimited minutes
Several teams and customers
Custom vocabulary and output formats
Setup help and training
Dedicated support', 'Contact sales', 0, 1, 0, 40,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
