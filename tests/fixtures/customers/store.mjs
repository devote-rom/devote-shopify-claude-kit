// A tiny pretend Shopify store for proving the journeys walk's logged-in customers without a real
// store or a real test account: a classic /account/login form that sets a cookie, product pages
// whose prices depend on that cookie, /products.json, /cart.js and a /cart page.
//
//   node tests/fixtures/customers/store.mjs 4101                   one store
//   node tests/fixtures/customers/store.mjs 4102 --plant           VIP sees 85.00, not 80.00, on the jacket
//   node tests/fixtures/customers/store.mjs 4103 --new-accounts    /account/login goes to new customer accounts
//
// The only login it accepts is LOGIN and PASSWORD below, dummy values that exist nowhere else.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { isMain } from "../../../scripts/platform.mjs";

export const LOGIN = "vip@example.test";
export const PASSWORD = "fixture-only-dummy";

const PRODUCTS = [
  { id: 1, handle: "trail-jacket", title: "Trail Jacket", options: [{ name: "Size" }], variants: [
    { id: 1001, option1: "Small", price: 10000, available: true },
    { id: 1002, option1: "Large", price: 12000, available: true },
    { id: 1003, option1: "XL", price: 12000, available: false },
  ] },
  { id: 2, handle: "camp-mug", title: "Camp Mug", options: [{ name: "Title" }], variants: [{ id: 2001, option1: "Default Title", price: 2500, available: true }] },
];

const money = (c) => `$${(c / 100).toFixed(2)}`;
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));

export function startStore({ port = 0, plant = false, newAccounts = false } = {}) {
  const carts = new Map();
  // a VIP pays 80%; with plant, the jacket's Small is 85.00 instead of 80.00 for a VIP
  const priceFor = (v, vip) => (!vip ? v.price : plant && v.id === 1001 ? 8500 : Math.round(v.price * 0.8));
  const productFor = (p, vip) => ({ ...p, variants: p.variants.map((v) => ({ ...v, price: priceFor(v, vip), compare_at_price: vip ? v.price : null })) });
  const asJson = (p) => ({ ...p, variants: p.variants.map((v) => ({ ...v, price: (v.price / 100).toFixed(2) })) });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const c = cookies(req);
    const vip = c.customer === "vip";
    let cartId = c.cart;
    const set = [];
    if (!cartId) { cartId = randomUUID(); set.push(`cart=${cartId}; Path=/; HttpOnly`); }
    const cart = carts.get(cartId) || []; carts.set(cartId, cart);
    const body = await new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });
    const send = (status, type, text, headers = {}) => { res.writeHead(status, { "content-type": type, ...(set.length ? { "set-cookie": set } : {}), ...headers }); res.end(text); };
    const go = (to) => send(302, "text/plain", "", { location: to });
    const cartJs = () => {
      const items = cart.map((l) => { const p = PRODUCTS.find((p) => p.variants.some((v) => v.id === l.id)); const v = p.variants.find((v) => v.id === l.id); return { id: v.id, quantity: l.quantity, handle: p.handle, title: p.title, price: priceFor(v, vip) }; });
      return { item_count: items.reduce((n, i) => n + i.quantity, 0), items };
    };
    const page = (title, main) => send(200, "text/html; charset=utf-8", `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px sans-serif;margin:0}header{display:flex;gap:16px;padding:16px;border-bottom:1px solid #ccc}main{padding:16px;min-height:900px}button,select,input{font:inherit;padding:8px;margin:4px}</style></head>
<body><header><a href="/">Home</a><a href="/collections/all">Shop</a><a href="/account">${vip ? "My account" : "Log in"}</a><a href="/cart">Cart <span class="cart-count">${cartJs().item_count}</span></a></header>
<main id="MainContent">${main}</main></body></html>`);

    const p = url.pathname;
    if (p === "/favicon.ico") return send(204, "text/plain", "");
    if (p === "/products.json" || /^\/collections\/[^/]+\/products\.json$/.test(p)) return send(200, "application/json", JSON.stringify({ products: PRODUCTS.map(asJson) }));
    if (p === "/" ) return page("Home", `<h1>Pretend store</h1>${PRODUCTS.map((x) => `<p><a href="/products/${x.handle}">${x.title}</a></p>`).join("")}`);
    if (/^\/collections\/[^/]+$/.test(p)) return page("Shop", PRODUCTS.map((x) => `<p><a href="/products/${x.handle}">${x.title}</a></p>`).join(""));

    if (p === "/account/login") {
      if (newAccounts) return go("/customer_authentication/redirect?locale=en");
      if (req.method === "POST") {
        const f = new URLSearchParams(body);
        if (f.get("customer[email]") === LOGIN && f.get("customer[password]") === PASSWORD) { set.push("customer=vip; Path=/; HttpOnly"); return go("/account"); }
        return page("Log in", `<p class="errors">Incorrect email or password.</p>${loginForm()}`);
      }
      return page("Log in", loginForm());
    }
    if (p === "/customer_authentication/redirect") return go("https://shopify.com/123456/account?locale=en");
    if (p === "/account") return vip ? page("Account", `<h1>My account</h1><p>${LOGIN}</p>`) : go("/account/login");
    if (p === "/account/logout") { set.push("customer=; Path=/; Max-Age=0"); return go("/"); }

    const prod = p.match(/^\/products\/([^/.]+)(\.js)?$/);
    if (prod) {
      const raw = PRODUCTS.find((x) => x.handle === prod[1]);
      if (!raw) return send(404, "text/html", "<h1>Not found</h1>");
      const x = productFor(raw, vip);
      if (prod[2]) return send(200, "application/json", JSON.stringify(x));
      const first = x.variants.find((v) => String(v.id) === url.searchParams.get("variant")) || x.variants.find((v) => v.available);
      return page(x.title, `<div class="product"><h1>${x.title}</h1>
<div class="price"><span class="price-item">${money(first.price)}</span> ${vip ? `<s class="price-compare">${money(first.compare_at_price)}</s>` : ""}</div>
${vip ? `<span class="badge">VIP price</span>` : ""}
<form action="/cart/add" method="post"><select name="id">${x.variants.map((v) => `<option value="${v.id}"${v.id === first.id ? " selected" : ""}>${v.option1}</option>`).join("")}</select>
<button type="submit" name="add">Add to cart</button></form></div>
<script>
const variants = ${JSON.stringify(x.variants)};
const form = document.querySelector('form'), sel = form.querySelector('select'), btn = form.querySelector('[name=add]');
const show = () => { const v = variants.find((v) => String(v.id) === sel.value);
  document.querySelector('.price-item').textContent = '$' + (v.price / 100).toFixed(2);
  btn.disabled = !v.available; btn.textContent = v.available ? 'Add to cart' : 'Sold out';
  history.replaceState(null, '', location.pathname + '?variant=' + v.id); };
sel.addEventListener('change', show);
form.addEventListener('submit', async (e) => { e.preventDefault();
  await fetch('/cart/add.js', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ id: Number(sel.value), quantity: 1 }] }) });
  const j = await fetch('/cart.js').then((r) => r.json()); document.querySelector('.cart-count').textContent = j.item_count; });
</script>`);
    }

    if (p === "/cart.js") return send(200, "application/json", JSON.stringify(cartJs()));
    if (p === "/cart/add.js" && req.method === "POST") {
      for (const it of JSON.parse(body || "{}").items || []) { const l = cart.find((l) => l.id === it.id); if (l) l.quantity += it.quantity; else cart.push({ id: it.id, quantity: it.quantity }); }
      return send(200, "application/json", JSON.stringify(cartJs()));
    }
    if (p === "/cart/change.js" && req.method === "POST") {
      const { line, quantity } = JSON.parse(body || "{}");
      if (cart[line - 1]) { if (quantity > 0) cart[line - 1].quantity = quantity; else cart.splice(line - 1, 1); }
      return send(200, "application/json", JSON.stringify(cartJs()));
    }
    if (p === "/cart/clear.js" && req.method === "POST") { cart.length = 0; return send(200, "application/json", JSON.stringify(cartJs())); }
    if (p === "/cart") {
      const j = cartJs();
      return page("Cart", j.items.length ? j.items.map((i, n) => `<div class="cart-item"><a href="/products/${i.handle}">${i.title}</a> ${money(i.price)}
<input name="updates[]" value="${i.quantity}" size="2"><button name="plus" data-line="${n + 1}" data-q="${i.quantity + 1}">+</button>
<button aria-label="Remove" data-line="${n + 1}" data-q="0">Remove</button></div>`).join("") + `<button name="checkout">Check out</button>
<script>for (const b of document.querySelectorAll('[data-line]')) b.addEventListener('click', async () => {
  await fetch('/cart/change.js', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ line: Number(b.dataset.line), quantity: Number(b.dataset.q) }) });
  // redrawn in place, the way a theme's cart section does, not with a reload
  const j = await fetch('/cart.js').then((r) => r.json()); const row = b.closest('.cart-item'); const n = Number(b.dataset.line);
  if (Number(b.dataset.q) === 0) row.remove(); else { row.querySelector('input').value = j.items[n - 1].quantity; row.querySelector('[name=plus]').dataset.q = j.items[n - 1].quantity + 1; }
  document.querySelector('.cart-count').textContent = j.item_count; });</script>` : "<p>Your cart is empty.</p>");
    }
    return send(404, "text/html", "<h1>Not found</h1>");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function loginForm() {
  return `<form action="/account/login" method="post"><input type="hidden" name="form_type" value="customer_login">
<input type="email" name="customer[email]" autocomplete="email"><input type="password" name="customer[password]">
<button type="submit">Sign in</button></form>`;
}

if (isMain(import.meta.url)) {
  const port = Number(process.argv[2] || 4101);
  startStore({ port, plant: process.argv.includes("--plant"), newAccounts: process.argv.includes("--new-accounts") })
    .then(() => console.log(`pretend store on http://127.0.0.1:${port}/${process.argv.slice(3).join(" ")}`));
}
