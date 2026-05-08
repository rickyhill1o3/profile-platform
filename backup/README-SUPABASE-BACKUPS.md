# Supabase Backup + Emergency Recovery Setup

This repo includes a GitHub Actions workflow that creates a nightly Supabase/Postgres backup and stores it as a GitHub Actions artifact.

## What this protects

The backup captures your Postgres database tables, including users, profiles, products, orders, credits, webhook routes, and settings.

It does **not** automatically back up uploaded files in Supabase Storage buckets. If you use Supabase Storage later, back that up separately.

## Files added

- `.github/workflows/supabase-nightly-backup.yml`
- `backup/README-SUPABASE-BACKUPS.md`

## Required GitHub secret

Create this repository secret:

```text
SUPABASE_DATABASE_URL
```

The value should be your Supabase Postgres connection string, usually from:

Supabase Dashboard → Project Settings → Database → Connection string → URI

Use the password for the database user. The URL usually looks similar to:

```text
postgresql://postgres.PROJECTREF:PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

or a direct connection string if Supabase gives you one.

## How to run a manual backup

1. Go to GitHub.
2. Open your repository.
3. Click **Actions**.
4. Click **Supabase Nightly Backup**.
5. Click **Run workflow**.
6. Wait for it to finish.
7. Open the completed workflow run.
8. Download the `supabase-backup-...` artifact.

## Backup schedule

The workflow runs every day at `07:15 UTC`, which is approximately `3:15 AM America/New_York` during daylight saving time.

## Restore basics

The workflow creates two files:

- `.dump` file: best for real restore using `pg_restore`
- `.sql.gz` file: readable SQL copy for inspection or emergency manual recovery

Restore to a **new Supabase project first**, then verify before pointing Render/Netlify at it.

Example restore command:

```bash
pg_restore --clean --if-exists --no-owner --no-acl \
  --dbname "NEW_SUPABASE_DATABASE_URL" \
  supabase-full-YYYY-MM-DDTHH-MM-SSZ.dump
```

Do not restore over production until you have verified the backup in a new project.

## Recommended routine

Every week:

1. Run the workflow manually.
2. Download the artifact.
3. Keep one copy on your computer or external drive.
4. Confirm the file is not 0 bytes.

Every month:

1. Restore a backup into a test Supabase project.
2. Make sure users/products/orders are visible.

