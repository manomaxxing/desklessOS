// The quote as a printable A4 HTML page, in the language of the call.

import { locales } from "../locale/index.mjs";

// Text per language from the locale pack (documents.quote); formats from its numberLocale.
const texts = lang => {
  const t = locales().document(lang, "quote");
  const female = new RegExp(`^(${(t.femalePrefixes ?? []).join("|") || "(?!)"})\\b`, "i");
  const fill = (tpl, name) => tpl.replace("{name}", name).replace("{first}", String(name).split(" ")[0]);
  return { ...t, greeting: name => (!name ? t.greetingNone : fill(female.test(name) ? t.greetingFemale : t.greetingDefault, name)) };
};
const numberLocale = lang => locales().get(lang).format?.numberLocale ?? locales().bcp47(lang);

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function money(n, lang = locales().defaultId, currency = "USD") {
  return n == null ? "" : new Intl.NumberFormat(numberLocale(lang), { style: "currency", currency }).format(n);
}

function fmtDate(iso, lang) {
  if (!iso) return "";
  return new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(numberLocale(lang), { dateStyle: "medium" });
}

export function renderQuoteHtml(q, company) {
  const t = texts(q.lang);
  const c = q.customer ?? {};
  const cur = q.currency ?? company.currency ?? "USD";
  const m = n => money(n, q.lang, cur);
  const qty = n => new Intl.NumberFormat(numberLocale(q.lang), { maximumFractionDigits: 2 }).format(n);
  const rows = q.lines.map(l => `
      <tr>
        <td class="num">${l.pos}</td>
        <td>${esc(l.description)}${l.note ? `<div class="sub">${esc(l.note)}</div>` : ""}</td>
        <td class="num">${qty(l.quantity)}</td>
        <td>${esc(l.unit)}</td>
        <td class="num">${l.unitPrice == null ? `<em>${t.onRequest}</em>` : m(l.unitPrice)}</td>
        <td class="num strong">${l.total == null ? "" : m(l.total)}</td>
      </tr>`).join("");
  return `<!doctype html>
<html lang="${esc(locales().get(q.lang).id)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.title} ${esc(q.number)} · ${esc(c.name)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
  :root { --ink: #1d1d1f; --muted: #6e6e73; --line: #e5e5ea; --accent: #0a84ff; --soft: #f5f5f7; }
  * { box-sizing: border-box; }
  html { background: #e9e9ee; }
  body { margin: 0; color: var(--ink); font: 13px/1.5 -apple-system, BlinkMacSystemFont, Inter, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  .page { width: 210mm; min-height: 297mm; margin: 24px auto; background: #fff; padding: 18mm 18mm 16mm; box-shadow: 0 10px 40px rgba(0,0,0,.12); position: relative; display: flex; flex-direction: column; }
  @media (max-width: 820px) { .page { width: 100%; min-height: 0; margin: 0; padding: 24px 18px; box-shadow: none; } }
  @media print { html { background: #fff; } .page { margin: 0; box-shadow: none; } .demo { display: none; } }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .brand { display: flex; gap: 12px; align-items: center; }
  .mark { width: 42px; height: 42px; border-radius: 11px; background: linear-gradient(135deg, #1d1d1f, #48484a); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 18px; letter-spacing: -0.02em; }
  .brand b { display: block; font-size: 17px; letter-spacing: -0.02em; } .brand span { color: var(--muted); font-size: 12px; }
  .sender { text-align: right; color: var(--muted); font-size: 11.5px; line-height: 1.55; }
  .addr { margin-top: 34px; display: flex; justify-content: space-between; gap: 24px; align-items: flex-end; }
  .back { font-size: 9.5px; color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: 3px; margin-bottom: 8px; }
  .to { font-size: 13.5px; line-height: 1.5; min-height: 70px; }
  .meta { border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; font-size: 12px; min-width: 240px; }
  .meta div { display: flex; justify-content: space-between; gap: 18px; padding: 2px 0; } .meta span { color: var(--muted); }
  h1 { font-size: 26px; letter-spacing: -0.03em; margin: 30px 0 4px; } h1 small { font-size: 14px; color: var(--muted); font-weight: 500; margin-left: 8px; }
  p { margin: 10px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; padding: 8px 6px; border-bottom: 1.5px solid var(--ink); }
  td { padding: 10px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; } th.num { text-align: right; }
  .strong { font-weight: 600; } .sub { color: var(--muted); font-size: 11.5px; margin-top: 2px; }
  .totals { margin-left: auto; width: 290px; margin-top: 14px; font-variant-numeric: tabular-nums; }
  .totals div { display: flex; justify-content: space-between; padding: 5px 6px; } .totals span { color: var(--muted); }
  .totals .gross { border-top: 1.5px solid var(--ink); margin-top: 4px; padding-top: 9px; font-size: 16px; font-weight: 700; } .totals .gross span { color: var(--ink); }
  .info { margin-top: 18px; background: var(--soft); border-radius: 12px; padding: 12px 14px; font-size: 12.5px; }
  .info b { font-weight: 600; }
  .sign { margin-top: 26px; } .sign .name { margin-top: 26px; font-weight: 600; }
  footer { margin-top: auto; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 10px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .demo { position: absolute; top: 10px; right: 18mm; font-size: 10px; color: #c77700; background: #fff4e5; border: 1px solid #ffd8a8; padding: 2px 8px; border-radius: 99px; }
</style>
</head>
<body>
<div class="page">
  <div class="demo">${t.demo}</div>
  <header>
    <div class="brand"><div class="mark">${esc(company.name.split(/\s+/).map(w => w[0]).join("").slice(0, 2))}</div><div><b>${esc(company.name)}</b><span>${esc(company.tagline)}</span></div></div>
    <div class="sender">${esc(company.street)}<br>${esc(company.city)}<br>${esc(company.phone)}<br>${esc(company.email)}</div>
  </header>
  <section class="addr">
    <div>
      <div class="back">${esc(company.name)} · ${esc(company.street)} · ${esc(company.city)}</div>
      <div class="to">${c.company ? `${esc(c.company)}<br>` : ""}${esc(c.name)}${c.address ? `<br>${esc(c.address).replace(/,\s*/g, "<br>")}` : ""}${c.email ? `<br><span style="color:var(--muted)">${esc(c.email)}</span>` : ""}</div>
    </div>
    <div class="meta">
      <div><span>${t.number}</span><b>${esc(q.number)}</b></div>
      <div><span>${t.date}</span>${fmtDate(q.createdAt, q.lang)}</div>
      <div><span>${t.valid}</span>${fmtDate(q.validUntil, q.lang)}</div>
      <div><span>${t.contact}</span>${esc(company.owner)}</div>
    </div>
  </section>
  <h1>${t.title}<small>${esc(q.number)}</small></h1>
  <p>${esc(t.greeting(c.name))}</p>
  <p>${t.intro}</p>
  <table>
    <thead><tr><th class="num">${t.pos}</th><th>${t.desc}</th><th class="num">${t.qty}</th><th>${t.unit}</th><th class="num">${t.price}</th><th class="num">${t.total}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div><span>${t.net}</span>${m(q.net)}</div>
    <div><span>${esc(company.taxLabel?.[q.lang] ?? company.taxLabel?.[company.lang] ?? "Tax")}</span>${m(q.vat)}</div>
    <div class="gross"><span>${t.gross}</span>${m(q.gross)}</div>
  </div>
  ${q.neededBy || q.notes ? `<div class="info">${q.neededBy ? `<b>${t.needed}:</b> ${fmtDate(q.neededBy, q.lang)}<br>` : ""}${q.notes ? `<b>${t.notes}:</b> ${esc(q.notes)}` : ""}</div>` : ""}
  <p style="margin-top:18px">${esc(company.paymentTerms?.[q.lang] ?? company.paymentTerms?.[company.lang] ?? "")}</p>
  <p>${t.closing}</p>
  <div class="sign">${t.regards}<div class="name">${esc(company.owner)}</div><div style="color:var(--muted)">${esc(company.name)}</div></div>
  <footer><span>${esc(company.name)} · ${esc(company.street)} · ${esc(company.city)}</span><span>${esc(company.license ?? company.vatId ?? "")}</span><span>${esc(company.bank)}</span><span>${t.page}</span></footer>
</div>
</body>
</html>`;
}
