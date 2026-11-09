-- Allow every retailer currently supported by the catalog application.
-- Run this once in Supabase SQL Editor. It replaces the older narrow checks
-- that can incorrectly reject Crunchyroll (or another newer store).

begin;

do $$
begin
    if to_regclass('public.product_catalogs') is not null then
        alter table public.product_catalogs
            drop constraint if exists product_catalogs_site_check;

        alter table public.product_catalogs
            add constraint product_catalogs_site_check
            check (site in (
                'amazon',
                'target',
                'walmart',
                'samsclub',
                'costco',
                'bandai',
                'crunchyroll',
                'pokemon',
                'pokemoncenter',
                'supreme',
                'general',
                'raffle'
            ));
    end if;

    if to_regclass('public.catalog_products') is not null then
        alter table public.catalog_products
            drop constraint if exists catalog_products_site_check;

        alter table public.catalog_products
            add constraint catalog_products_site_check
            check (site in (
                'amazon',
                'target',
                'walmart',
                'samsclub',
                'costco',
                'bandai',
                'crunchyroll',
                'pokemon',
                'pokemoncenter',
                'supreme',
                'general',
                'raffle'
            ));
    end if;
end
$$;

commit;
