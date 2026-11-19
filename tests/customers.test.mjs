// The journeys walk's logged-in customers: where a login may come from, what is refused, the
// verdicts, and that no credential can reach the output. The login check runs against the
// pretend store in tests/fixtures/customers/, never a real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterLogin, compareWithGuest, comparePrices, customerVerdict, envNames, loginKind, newAccountsAt, opProblem, opRead,
  priceDifferences, redact, resolveCredentials, validateCustomers,
} from "../scripts/qa/customers.mjs";
import { validateJourneys, pricePaths } from "../scripts/qa/journeys-walk.mjs";
import { startStore } from "./fixtures/customers/store.mjs";

const REF = { login: "op://Shopify QA/Test VIP/username", password: "op://Shopify QA/Test VIP/password" };

test("customers: op:// references pass, a plain value is refused and never repeated", () => {
  const ok = validateCustomers([{ name: "VIP", ...REF, expect: { priceDiffersFromGuest: true } }]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.customers[0].password, REF.password);
  const bad = validateCustomers([{ name: "VIP", login: REF.login, password: "hunter2-plain" }]);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /password is not a 1Password reference/);
  assert.match(bad.errors[0], /JOURNEYS_VIP_PASSWORD/);
  assert.ok(!bad.errors[0].includes("hunter2-plain"), "the refusal must not print the value");
  assert.deepEqual(bad.customers, []);
  assert.match(validateCustomers([{ name: "VIP", login: "vip@example.test" }]).errors[0], /login is not a 1Password reference/);
  assert.match(validateCustomers([{ name: "VIP", password: "op:/half/ref" }]).errors[0], /not a 1Password reference/);
  assert.match(validateCustomers([{ name: "VIP", password: 42 }]).errors[0], /not a 1Password reference/);
});

test("customers: names, duplicates, unknown keys and expect are checked", () => {
  assert.match(validateCustomers({}).errors[0], /must be a list/);
  assert.match(validateCustomers([{ ...REF }]).errors[0], /needs a name/);
  assert.match(validateCustomers([{ name: "VIP", ...REF }, { name: "vip", ...REF }]).errors[0], /already used/);
  assert.match(validateCustomers([{ name: "VIP", ...REF, tags: ["VIP"] }]).errors[0], /unknown key "tags"/);
  assert.match(validateCustomers([{ name: "VIP", ...REF, expect: { priceDiffersFromGuest: "yes" } }]).errors[0], /true or false/);
  assert.match(validateCustomers([{ name: "VIP", ...REF, expect: { cheaper: true } }]).errors[0], /not known/);
});

test("journeys.json: customers and \"customers\": true on a journey are read, a plain password stops everything", () => {
  const v = validateJourneys({ customers: [{ name: "Trade AU", ...REF }], journeys: [{ name: "Trade price note", customers: true, steps: [{ goto: "/products/a" }] }] });
  assert.deepEqual(v.errors, []);
  assert.equal(v.customers[0].name, "Trade AU");
  assert.equal(v.journeys[0].customers, true);
  const bad = validateJourneys({ customers: [{ name: "VIP", login: REF.login, password: "plain-text-pw" }] });
  assert.equal(bad.errors.length, 1);
  assert.ok(!bad.errors.join(" ").includes("plain-text-pw"));
  assert.match(validateJourneys({ journeys: [{ name: "x", customers: "yes", steps: [{ goto: "/" }] }] }).errors[0], /customers must be true or false/);
});

test("env var names for CI: JOURNEYS_<NAME>_LOGIN and _PASSWORD", () => {
  assert.deepEqual(envNames("VIP"), { login: "JOURNEYS_VIP_LOGIN", password: "JOURNEYS_VIP_PASSWORD" });
  assert.deepEqual(envNames("Trade AU"), { login: "JOURNEYS_TRADE_AU_LOGIN", password: "JOURNEYS_TRADE_AU_PASSWORD" });
  assert.deepEqual(envNames("epv-guide"), { login: "JOURNEYS_EPV_GUIDE_LOGIN", password: "JOURNEYS_EPV_GUIDE_PASSWORD" });
});

test("credentials: env vars win, op:// is read with op, any failure is an error (NOT CHECKED), never a skip", async () => {
  const reads = [];
  const read = async (ref) => { reads.push(ref); return { value: `value of ${ref}` }; };
  const c = { name: "VIP", ...REF };
  assert.deepEqual(await resolveCredentials(c, { env: {}, read }), { login: `value of ${REF.login}`, password: `value of ${REF.password}` });
  assert.deepEqual(await resolveCredentials(c, { env: { JOURNEYS_VIP_LOGIN: "ci@example.test", JOURNEYS_VIP_PASSWORD: "ci-secret" }, read }), { login: "ci@example.test", password: "ci-secret" });
  assert.equal(reads.length, 2, "env values are not sent to op");
  const failing = async () => ({ error: "op is not signed in to 1Password" });
  assert.match((await resolveCredentials(c, { env: {}, read: failing })).error, /could not read the login from 1Password: op is not signed in/);
  assert.match((await resolveCredentials({ name: "VIP" }, { env: {}, read })).error, /no login.*JOURNEYS_VIP_LOGIN/);
});

test("op: missing, not signed in, no such item and a timeout each say why, without op's own output", async () => {
  assert.match(opProblem({ code: "ENOENT" }), /not installed/);
  assert.match(opProblem({ code: 1 }, "[ERROR] 2026/11/19 account is not signed in"), /not signed in/);
  assert.match(opProblem({ code: 1 }, `[ERROR] "Bogus" isn't a vault in this account`), /no vault, item or field/);
  assert.match(opProblem({ killed: true, signal: "SIGTERM" }), /did not answer in time/);
  const leaky = opProblem({ code: 1 }, "something odd about secret-xyz");
  assert.ok(!leaky.includes("secret-xyz"));
  const fakeRun = (bin, args, opts, cb) => cb(Object.assign(new Error("x"), { code: 1 }), "", "account is not signed in");
  assert.match((await opRead("op://a/b/c", { run: fakeRun })).error, /not signed in/);
  const missing = await opRead("op://a/b/c", { bin: "/nonexistent/op-cli" });
  assert.match(missing.error, /not installed/);
  const okRun = (bin, args, opts, cb) => { assert.deepEqual(args, ["read", "--no-newline", "op://a/b/c"]); cb(null, "the-value", ""); };
  assert.deepEqual(await opRead("op://a/b/c", { run: okRun }), { value: "the-value" });
});

test("no credential can reach the report: redact hides the login and password, plain and URL-encoded", () => {
  const login = "buyer+vip@example.test", password = "s3cret pass&word";
  const lines = [
    `could not log in: the page said Welcome back ${login}`,
    `posted customer%5Bemail%5D=${encodeURIComponent(login)}&customer%5Bpassword%5D=${encodeURIComponent(password)}`,
    `typed ${password} into the field`,
  ];
  const out = lines.map((l) => redact(l, [login, password])).join("\n");
  assert.ok(!out.includes(login) && !out.includes(password));
  assert.ok(!out.includes(encodeURIComponent(login)) && !out.includes(encodeURIComponent(password)));
  assert.match(out, /\[hidden\]/);
});

test("new customer accounts are recognised, classic ones are not", () => {
  assert.ok(newAccountsAt("https://shopify.com/123456/account?locale=en", "https://acme.com"));
  assert.ok(newAccountsAt("https://shopify.com/authentication/123456/login", "https://acme.com"));
  assert.ok(newAccountsAt("/customer_authentication/redirect?locale=en", "https://acme.com"));
  assert.ok(!newAccountsAt("/account", "https://acme.com"));
  assert.ok(!newAccountsAt("https://acme.com/account/login", "https://acme.com"));
  assert.equal(afterLogin("https://acme.com/account", "https://acme.com").status, "ok");
  assert.equal(afterLogin("https://acme.com/account/login", "https://acme.com").status, "refused");
  assert.equal(afterLogin("https://acme.com/challenge", "https://acme.com").status, "captcha");
  assert.equal(afterLogin("https://shopify.com/1/account", "https://acme.com").status, "new");
});

test("the pretend store: /account/login is a classic form, or new customer accounts when it redirects there", async () => {
  const classic = await startStore(), modern = await startStore({ newAccounts: true });
  try {
    const at = (s) => `http://127.0.0.1:${s.address().port}/account/login`;
    assert.deepEqual(await loginKind(at(classic)), { kind: "classic" });
    assert.deepEqual(await loginKind(at(modern)), { kind: "new" });
  } finally { classic.close(); modern.close(); }
});

test("prices: a difference between live and the preview for the same customer FAILS", () => {
  const vip = { price: "$80.00", compareAt: "$100.00", labels: ["VIP price"], buyable: true };
  const rows = comparePrices({ "/products/a": vip, "/products/b": vip, "/products/c": { error: "returned 500" } }, { "/products/a": vip, "/products/b": { ...vip, price: "$85.00" }, "/products/c": vip });
  assert.deepEqual(rows.map((r) => r.outcome), ["pass", "FAIL", "notchecked"]);
  assert.match(rows[1].detail, /price: live "\$80.00", preview "\$85.00"/);
  assert.match(priceDifferences({ ...vip, buyable: true }, { ...vip, buyable: false }).join(), /add to cart: live works, preview off/);
  assert.match(priceDifferences(vip, { ...vip, labels: [] }).join(), /labels/);
  const v = customerVerdict({ priceRows: rows, name: "VIP" });
  assert.equal(v.fails.length, 1);
  assert.equal(v.notChecked.length, 1);
});

test("prices: guest prices on live when a difference is expected FAIL; without expect it is only information", () => {
  const guest = { price: "$100.00", compareAt: "", labels: [], buyable: true };
  const same = compareWithGuest({ "/products/a": guest }, { "/products/a": guest }, "VIP");
  assert.equal(same[0].same, true);
  const pass = comparePrices({ "/products/a": guest }, { "/products/a": guest });
  const v = customerVerdict({ priceRows: pass, guestRows: same, expect: { priceDiffersFromGuest: true }, name: "VIP" });
  assert.equal(v.fails.length, 1);
  assert.match(v.fails[0], /same prices as a guest.*missing its tag/);
  assert.deepEqual(customerVerdict({ priceRows: pass, guestRows: same, expect: {}, name: "VIP" }).fails, []);
  const differs = compareWithGuest({ "/products/a": { ...guest, price: "$80.00" } }, { "/products/a": guest }, "VIP");
  assert.match(differs[0].detail, /price: guest "\$100.00", VIP "\$80.00"/);
  assert.deepEqual(customerVerdict({ priceRows: pass, guestRows: differs, expect: { priceDiffersFromGuest: true } }).fails, []);
  const unread = customerVerdict({ priceRows: pass, guestRows: [{ readable: false }], expect: { priceDiffersFromGuest: true } });
  assert.equal(unread.notChecked.length, 1);
  assert.equal(customerVerdict({ priceRows: [] }).notChecked.length, 1, "no product pages is NOT CHECKED, not a pass");
});

test("price pages: product pages from the page lists, else the walk's own products", () => {
  assert.deepEqual(pricePaths(["/", "/collections/all", "/products/a", "/products/a", "/products/FILL-IN"], {}), ["/products/a"]);
  assert.deepEqual(pricePaths(["/"], { variantProduct: { handle: "v" }, buy: { handle: "b" } }), ["/products/v", "/products/b"]);
});
