'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { createClient } = require('@supabase/supabase-js');
const registerCatalogRoutes = require('../product-catalog-routes');
const {
    buildTargetImageMatches, loadTargetImageMatches, parseTargetImageSelections, applyTargetImageMatches
} = require('../catalog-target-image-matches');

const image = (name) => 'https://target.scene7.com/is/image/Target/' + name;
const amazon = (id, product_name, extra = {}) => ({
    id, site: 'amazon', catalog_id: 'amazon-live', sku: 'B0H77W441' + id.at(-1), product_name,
    image_url: '', default_max_price: 22, credit_cost: 5, is_enabled: true, ...extra
});
const target = (id, product_name, extra = {}) => ({
    id, site: 'target', catalog_id: 'target-live', sku: '101285057' + id.at(-1), product_name,
    image_url: image(id), default_max_price: 29, credit_cost: 2, is_enabled: true, ...extra
});
const poster = 'Pokémon TCG: 30th Celebration Poster Collection';
const binder = 'Pokemon TCG 30th Celebration Binder Collection';

function testMatches() {
    const build = (a, t) => buildTargetImageMatches([a], t);
    const exact = build(amazon('a1', poster), [target('t1', 'Pokemon Trading Card Game — 30th Celebration Poster Collection')]);
    assert.equal(exact.matches[0].method, 'title');
    assert.equal(exact.matches[0].target.image_url, image('t1'));
    const similar = build(amazon('a1', poster), [target('t1', poster + ' Cards')]);
    assert.equal(similar.matches[0].method, 'similar_title');
    const code = build(amazon('a1', 'Pokemon Charizard Collection', { metadata: { upc: '123456789012' } }), [
        target('t1', 'Pokemon TCG Gift Collection', { metadata: { gtin13: '0123456789012' } })
    ]);
    assert.equal(code.matches[0].method, 'upc');

    for (const [left, right] of [
        ['Pokemon 30th Celebration Ultra-Premium Collection Day', 'Pokemon 30th Celebration Ultra Premium Collection Night'],
        ['Pokemon 30th Celebration Ultra-Premium Collection', 'Pokemon 30th Celebration Ultra Premium Collection Night'],
        ['Pokemon Ascended Heroes Booster Bundle', 'Pokemon Ascended Heroes Booster Display'],
        ['Pokemon Mega Forces Tin Dragonite ex', 'Pokemon Mega Forces Tin Charizard ex'],
        ['NeeDoh Teenie Cool Cat 3PK', 'NeeDoh Teenie Cool Cat 6 Pack'],
        ['Pokemon 30th Celebration Poster Collection', 'Pokemon 25th Celebration Poster Collection']
    ]) {
        const result = build(amazon('a1', left), [target('t1', right)]);
        assert.equal(result.matches.length, 0, left + ' should not match ' + right);
        assert.equal(result.unmatched[0].reason, 'no_match');
    }
    assert.equal(build(amazon('a1', poster, { metadata: { upc: '123456789012' } }), [
        target('t1', poster, { metadata: { upc: '123456789019' } })
    ]).matches.length, 0, 'different product codes are a conflict even when titles agree');
    assert.equal(build(amazon('a1', poster), [target('t1', poster), target('t2', poster)]).unmatched[0].reason, 'multiple_matches');
    assert.equal(build(amazon('a1', poster), [
        target('t1', poster, { image_url: 'https://target.scene7.com.invalid/is/image/Target/wrong' }),
        target('t2', poster, { sku: '1012850570,1012850572' })
    ]).matches.length, 0);
    assert.equal(build(amazon('a1', poster, { image_url: image('existing') }), [target('t1', poster)]).matches.length, 0);
    assert.equal(parseTargetImageSelections([{}, {}]), null);
    assert.equal(parseTargetImageSelections(Array(51).fill({})), null);
}

function fakeCatalogs(rows) {
    const writes = [];
    const supabase = createClient('https://catalog-image-test.example', 'test-key', {
        global: { fetch: async (input, options) => {
            const { pathname, searchParams } = new URL(input);
            const site = searchParams.get('site').slice(3);
            if (pathname.endsWith('/product_catalogs')) {
                assert.equal(searchParams.get('is_active'), 'eq.true');
                assert.equal(options.method, 'GET');
                return Response.json([{ id: site + '-live' }]);
            }
            assert.ok(pathname.endsWith('/catalog_products'), 'no non-catalog data is read or written');
            assert.equal(searchParams.get('catalog_id'), 'eq.' + site + '-live');
            assert.equal(searchParams.get('is_enabled'), 'eq.true');
            const filtered = rows.filter((row) => {
                for (const [column, filter] of searchParams) {
                    if (filter.startsWith('eq.') && String(row[column]) !== filter.slice(3)) return false;
                    if (filter.startsWith('in.(') && !filter.slice(4, -1).split(',').includes(row[column])) return false;
                    if (column === 'or' && row.image_url !== '' && row.image_url !== null) return false;
                    if (column === 'image_url' && !row.image_url) return false;
                }
                return true;
            });
            if (options.method === 'PATCH') {
                const patch = JSON.parse(options.body);
                assert.equal(site, 'amazon');
                assert.deepEqual(Object.keys(patch), ['image_url']);
                assert.equal(searchParams.get('or'), '(image_url.is.null,image_url.eq.)');
                assert.ok(searchParams.get('sku') && searchParams.get('product_name'));
                assert.ok(filtered.length <= 1);
                if (!filtered.length) return Response.json(null);
                Object.assign(filtered[0], patch);
                writes.push(filtered[0].id);
                return Response.json({ id: filtered[0].id });
            }
            assert.equal(options.method, 'GET');
            const offset = Number(searchParams.get('offset'));
            return Response.json(filtered.slice(offset, offset + Number(searchParams.get('limit'))));
        } }
    });
    return { supabase, writes };
}

async function testRoutesAndUpdate() {
    const rows = [
        amazon('a1', poster), amazon('a2', binder), amazon('a3', poster, { image_url: image('existing') }),
        amazon('a4', binder, { is_enabled: false }), amazon('a5', 'Amazon only product'),
        target('t1', poster), target('t2', binder), target('t3', poster, { catalog_id: 'target-retired' }),
        target('t4', poster, { is_enabled: false })
    ];
    const { supabase, writes } = fakeCatalogs(rows);
    const routes = new Map();
    const app = Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map((method) => [
        method, (route, ...handlers) => routes.set(method + ' ' + route, handlers)
    ]));
    const identity = () => {};
    registerCatalogRoutes({ app, supabase, auth: identity, admin: identity });
    const previewRoute = routes.get('get /admin/catalog-products/amazon-target-image-matches');
    const applyRoute = routes.get('post /admin/catalog-products/apply-amazon-target-images');
    assert.equal(previewRoute[0], identity);
    assert.equal(applyRoute[1], identity);
    async function call(route, role = 'super_admin', body) {
        const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; }, set() {} };
        await route.at(-1)({ role, body }, res);
        return res;
    }
    assert.equal((await call(previewRoute, 'admin')).code, 403);
    assert.equal((await call(applyRoute, 'admin')).code, 403);
    assert.equal((await call(applyRoute)).code, 400);
    const { matches, unmatched } = (await call(previewRoute)).data;
    assert.deepEqual(matches.map((pair) => pair.amazon.id), ['a1', 'a2']);
    assert.deepEqual(unmatched.map((row) => row.asin), ['B0H77W4415']);
    assert.deepEqual(writes, []);
    const selection = (pair) => ({ amazon_id: pair.amazon.id, match_token: pair.match_token });
    rows[6].image_url = image('new-binder');
    const result = await call(applyRoute, 'super_admin', { matches: matches.map(selection) });
    assert.deepEqual(result.data, { updated: ['a1'], skipped: ['a2'], failed: [] });
    assert.deepEqual(writes, ['a1']);
    assert.equal(rows[0].image_url, image('t1'));
    assert.equal(rows[0].default_max_price, 22);
    assert.equal(rows[0].credit_cost, 5);
    assert.equal(rows[1].image_url, '');
    assert.equal(rows[2].image_url, image('existing'));
    const fresh = await loadTargetImageMatches(supabase);
    assert.equal(fresh.matches[0].target.image_url, image('new-binder'));
    rows[1].image_url = image('concurrent');
    assert.deepEqual(await applyTargetImageMatches(supabase, parseTargetImageSelections(fresh.matches.map(selection))),
        { updated: [], skipped: ['a2'], failed: [] });
    assert.equal(rows[1].image_url, image('concurrent'));
    return matches;
}

async function testPreviewButton(matches) {
    const html = readFileSync(join(__dirname, '../../frontend/admin.html'), 'utf8');
    const script = readFileSync(join(__dirname, '../../frontend/script.js'), 'utf8');
    assert.match(html, />Preview Target Image Matches</);
    const buttons = {};
    const node = (id) => ({
        addEventListener(event, handler) { buttons[id + ':' + event] = handler; },
        replaceChildren() {}, querySelectorAll() { return []; }
    });
    const ids = new Map();
    const calls = [];
    const start = script.indexOf('function initTargetImageMatches()');
    const end = script.indexOf('async function initCatalogTools()', start);
    assert.ok(start >= 0 && end > start);
    vm.runInNewContext(script.slice(start, end) + '\ninitTargetImageMatches();', {
        document: { getElementById(id) { if (!ids.has(id)) ids.set(id, node(id)); return ids.get(id); } },
        escapeHTML: String, API: '',
        authJSON: async (url) => { calls.push(url); return { matches, unmatched: [] }; }
    });
    await buttons['previewTargetImageMatchesButton:click']();
    const list = ids.get('targetImageMatchesList');
    assert.match(list.innerHTML, /Target product photo/);
    assert.doesNotMatch(list.innerHTML, /\schecked(?:[\s=>]|$)/);
    assert.equal(ids.get('applyTargetImageMatchesButton').disabled, true);
    await buttons['applyTargetImageMatchesButton:click']();
    assert.deepEqual(calls, ['/admin/catalog-products/amazon-target-image-matches']);
}

(async () => {
    testMatches();
    await testPreviewButton(await testRoutesAndUpdate());
    console.log('Target-to-Amazon image matching, preview, permissions, and image-only save tests passed.');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
