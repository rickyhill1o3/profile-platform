-- Community success image storage
-- Run once in the Supabase SQL Editor before deploying this update.
-- The backend uses the service-role key to upload and remove files.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'community-success',
  'community-success',
  true,
  15728640,
  array['image/jpeg','image/png','image/webp','image/gif','image/avif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public bucket files can be displayed by the homepage without signed URLs.
-- Upload/delete operations remain server-side through the service-role client.
