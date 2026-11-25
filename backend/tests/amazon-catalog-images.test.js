'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createClient } = require('@supabase/supabase-js');
const { fillAmazonCatalogImageBatch, lookupAmazonCatalogImage } = require('../amazon-catalog-images');
const registerCatalogRoutes = require('../product-catalog-routes');

const poster = 'B0H77W4411';
const cat = 'B0C6WZTWZ6';
const image = 'https://m.media-amazon.com/images/I/poster.jpg';
const secondImage = 'https://m.media-amazon.com/images/I/cat.jpg';
const existingImage = 'https://m.media-amazon.com/images/I/keep.jpg';

async function testLookup() {
    const paths = [];
    const result = await lookupAmazonCatalogImage(poster, async (rawUrl, options) => {
        const url = new URL(rawUrl);
        paths.push(url.pathname + url.search);
        assert.equal(url.origin, 'https://www.amazon.com');
        assert.equal(options.redirect, 'manual');
        assert.ok(options.signal);
        return new Response(`<input id="ASIN" value="${poster}">
            <img id="landingImage" src="https://m.media-amazon.com/images/G/placeholder.gif"
            data-a-dynamic-image='{"${secondImage}":[300,300],"${image}":[1200,900]}'>`);
    });
    assert.equal(result, image);
    assert.deepEqual(paths, [`/dp/${poster}`]);

    const fallback = await lookupAmazonCatalogImage(cat, async (rawUrl) => {
        const url = new URL(rawUrl);
        if (url.pathname.startsWith('/dp/')) {
            return new Response(`<link rel="canonical" href="https://www.amazon.com/dp/${poster}"><img id="landingImage" src="${image}">`);
        }
        assert.equal(url.searchParams.get('k'), cat);
        return new Response(`
            <div data-component-type="s-search-result" data-asin="${poster}"><img class="s-image" src="${image}"></div>
            <div data-component-type="s-search-result" data-asin="${cat}"><img class="s-image" src="https://unrelated.example/images/I/spoof.jpg"></div>
            <div data-component-type="s-search-result" data-asin="${cat}"><img class="s-image" src="${secondImage}"></div>`);
    });
    assert.equal(fallback, secondImage);

    assert.equal(await lookupAmazonCatalogImage(cat, async () => new Response(
        `<div data-component-type="s-search-result" data-asin="${poster}"><img class="s-image" src="${image}"></div>`
    )), '');
    assert.equal(await lookupAmazonCatalogImage('not an asin', () => assert.fail('invalid ASIN made a request')), '');

    let blockedCalls = 0;
    await assert.rejects(lookupAmazonCatalogImage(cat, async () => {
        blockedCalls++;
        return new Response('', { status: 429 });
    }), /Amazon.*HTTP 429/);
    assert.equal(blockedCalls, 1);
    await assert.rejects(lookupAmazonCatalogImage(cat, async () => new Response(
        '<form action="/errors/validateCaptcha"><input id="captchacharacters"></form>'
    )), /asking for verification/);
}

function product(id, sku, options = {}) {
    return {
        id, sku, catalog_id: 'current', site: 'amazon', is_enabled: true,
        image_url: null, product_name: 'Original product', default_max_price: 22,
        credit_cost: 5, ...options
    };
}

function makeDatabase(rows) {
    const writes = [];
    const supabase = createClient('https://catalog-test.example', 'test-key', {
        global: {
            async fetch(rawUrl, { method, body } = {}) {
                const url = new URL(rawUrl);
                if (url.pathname.endsWith('/product_catalogs')) {
                    assert.equal(url.searchParams.get('site'), 'eq.amazon');
                    assert.equal(url.searchParams.get('is_active'), 'eq.true');
                    return Response.json([{ id: 'current' }]);
                }
                assert.ok(url.pathname.endsWith('/catalog_products'), 'no other tables are accessed');
                assert.equal(url.searchParams.get('site'), 'eq.amazon');
                assert.equal(url.searchParams.get('catalog_id'), 'eq.current');
                assert.equal(url.searchParams.get('is_enabled'), 'eq.true');
                assert.equal(url.searchParams.get('or'), '(image_url.is.null,image_url.eq.)');
                const filters = [...url.searchParams.entries()].filter(([, value]) => /^(?:eq|gt)\./.test(value));
                const matches = rows.filter((row) => {
                    if (row.image_url !== null && row.image_url !== '') return false;
                    return filters.every(([column, condition]) => condition.startsWith('eq.')
                        ? String(row[column]) === condition.slice(3)
                        : row[column] > condition.slice(3));
                }).sort((a, b) => a.id.localeCompare(b.id));
                if (method === 'PATCH') {
                    assert.ok(url.searchParams.get('sku'), 'do not write if the ASIN was edited');
                    const changes = JSON.parse(body);
                    assert.deepEqual(Object.keys(changes), ['image_url']);
                    for (const row of matches) {
                        Object.assign(row, changes);
                        writes.push(row.id);
                    }
                    return Response.json(matches[0] || null);
                }
                return Response.json(matches.slice(0, Number(url.searchParams.get('limit'))));
            }
        }
    });
    return { supabase, writes };
}

async function testBatch() {
    const rows = [
        product('01', poster),
        product('02', 'B123456789', { image_url: '' }),
        product('03', 'AMAZON-NEXT-DROP', { metadata: { virtual: true } }),
        product('04', cat),
        product('05', 'B999999999'),
        product('06', 'B888888888', { image_url: existingImage }),
        product('07', 'B777777777', { is_enabled: false }),
        product('08', 'B666666666', { catalog_id: 'archived' }),
        product('09', 'B555555555', { site: 'target' })
    ];
    const original = structuredClone(rows);
    const { supabase, writes } = makeDatabase(rows);
    const lookups = [];
    const lookup = async (asin) => {
        lookups.push(asin);
        if (asin === 'B999999999') {
            rows[4].image_url = existingImage; // Simulate a manual edit during the request.
            return image;
        }
        return ({ [poster]: image, [cat]: secondImage })[asin] || '';
    };
    const first = await fillAmazonCatalogImageBatch(supabase, '', lookup);
    assert.equal(first.checked, 3);
    assert.equal(first.updated, 1);
    assert.equal(first.skipped, 1);
    assert.equal(first.done, false);
    assert.deepEqual(first.failed.map((row) => row.asin), ['B123456789']);

    const second = await fillAmazonCatalogImageBatch(supabase, first.next_after_id, lookup);
    assert.equal(second.checked, 2);
    assert.equal(second.updated, 1);
    assert.equal(second.skipped, 1);
    assert.equal(second.done, true);
    assert.deepEqual(lookups, [poster, 'B123456789', cat, 'B999999999']);
    assert.deepEqual(writes, ['01', '04']);
    assert.deepEqual(rows, original.map((row, i) => ({
        ...row, image_url: ({ 0: image, 3: secondImage, 4: existingImage })[i] ?? row.image_url
    })), 'prices, credits, names, and existing images are unchanged');

    const remaining = await fillAmazonCatalogImageBatch(supabase, second.next_after_id);
    assert.equal(remaining.checked, 0);
    const paused = await fillAmazonCatalogImageBatch(supabase, '', (asin) =>
        lookupAmazonCatalogImage(asin, async () => new Response('', { status: 503 })));
    assert.equal(paused.checked, 1);
    assert.equal(paused.done, true);
    assert.match(paused.paused, /HTTP 503/);
}

async function testRouteAndButton() {
    const routes = new Map();
    const app = Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map((method) => [
        method, (route, ...handlers) => routes.set(`${method} ${route}`, handlers)
    ]));
    const identity = () => {};
    const routePath = '/admin/catalog-products/fill-amazon-images';
    const { supabase } = makeDatabase([product('01', poster, { image_url: image })]);
    registerCatalogRoutes({ app, supabase, auth: identity, admin: identity });
    const [auth, admin, route] = routes.get(`post ${routePath}`);
    assert.equal(auth, identity);
    assert.equal(admin, identity);
    async function request(role, body = {}) {
        const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
        await route({ role, body }, res);
        return res;
    }
    assert.equal((await request('admin')).code, 403);
    assert.equal((await request('super_admin', { after_id: '01,or()' })).code, 400);
    assert.equal((await request('super_admin')).data.done, true);

    const script = fs.readFileSync(path.join(__dirname, '../../frontend/script.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../../frontend/admin.html'), 'utf8');
    const start = script.indexOf('    if (fillAmazonCatalogImagesButton && superAdmin) {');
    const end = script.indexOf('    if (bulkImportForm && superAdmin) {', start);
    assert.ok(start > 0 && end > start);
    assert.match(html, /id="fillAmazonCatalogImagesButton">Fill Missing Amazon Images/);
    assert.match(html, /script\.js\?v=.*-amazon-images/);
    const button = { addEventListener(event, handler) { assert.equal(event, 'click'); this.click = handler; } };
    const status = {};
    const failures = {};
    const list = { replaceChildren() { this.children = []; }, appendChild(item) { this.children.push(item); } };
    const queries = [];
    vm.runInNewContext(script.slice(start, end), {
        superAdmin: true, fillAmazonCatalogImagesButton: button,
        amazonCatalogImageStatus: status, amazonCatalogImageFailures: failures, amazonCatalogImageFailureList: list,
        document: { createElement: () => ({}) }, API: '',
        authJSON: async (url, { method, body }) => {
            assert.equal(url, routePath);
            assert.equal(method, 'POST');
            assert.equal(button.disabled, true);
            queries.push(JSON.parse(body));
            return queries.length === 1
                ? { checked: 3, updated: 3, done: false, next_after_id: '03' }
                : { checked: 2, updated: 1, done: true, failed: [{ asin: cat, reason: 'No matching product image found' }] };
        }
    });
    await button.click();
    assert.deepEqual(queries, [{ after_id: '' }, { after_id: '03' }]);
    assert.match(status.textContent, /4 images added\. 5 products checked/);
    assert.equal(failures.hidden, false);
    assert.match(list.children[0].textContent, new RegExp(cat));
    assert.equal(button.disabled, false);
}

(async () => {
    await testLookup();
    await testBatch();
    await testRouteAndButton();
    console.log('Amazon image-only lookup, batch safety, permissions, and button tests passed.');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
