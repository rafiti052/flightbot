import { chromium } from "playwright";

const url =
  "https://www.google.com/travel/flights/search?q=Round-trip%20GRU%20to%20LIS%202026-04-14%20return%202026-04-24&curr=BRL&hl=en";

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  locale: "en-US",
  timezoneId: "America/Sao_Paulo",
});

const page = await context.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });

const popupSels = [
  'button[aria-label="Accept all"]',
  'button[aria-label="Reject all"]',
  '[jsname="b3VHJd"]',
  '.tHlp8d button',
];
for (const sel of popupSels) {
  try {
    const el = await page.$(sel);
    if (el) await el.click();
  } catch {}
}

try {
  await page.waitForSelector("li[jsname='pbdLld'], li.pIav2d", { timeout: 30000 });
} catch {}
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll("li.pIav2d, li[jsname='pbdLld']"));
  console.log("Total cards:", cards.length);

  const results = cards.slice(0, 3).map((card, i) => {
    // Check what price selectors exist inside this card
    const priceSels = ["[data-gs]", ".YMlIz", ".FpEdX", ".FpEdX span", "[jsname='Hf6lbd'] span", ".U3gSDe .FpEdX", ".BVAVmf"];
    const priceHits = {};
    for (const s of priceSels) {
      const el = card.querySelector(s);
      if (el) {
        priceHits[s] = {
          innerText: el.innerText?.trim().slice(0, 50),
          dataGs: el.getAttribute("data-gs")?.slice(0, 80),
        };
      }
    }

    // Other fields
    const airlineSels = [".sSHqwe", ".Xsgmwe", ".h1fkLb"];
    const airlineHits = {};
    for (const s of airlineSels) {
      const el = card.querySelector(s);
      if (el) airlineHits[s] = el.innerText?.trim().slice(0, 50);
    }

    const durationSels = [".gvkrdb", ".AdWm1c", ".vt2Lfd"];
    const durationHits = {};
    for (const s of durationSels) {
      const el = card.querySelector(s);
      if (el) durationHits[s] = el.innerText?.trim().slice(0, 50);
    }

    const stopSels = [".EfT7Ae span", ".ogfYpf", ".x7Eo2d"];
    const stopHits = {};
    for (const s of stopSels) {
      const el = card.querySelector(s);
      if (el) stopHits[s] = el.innerText?.trim().slice(0, 50);
    }

    return {
      cardIndex: i,
      priceHits,
      airlineHits,
      durationHits,
      stopHits,
      snippet: card.innerHTML.slice(0, 500),
    };
  });

  return results;
});

for (const r of info) {
  console.log(`\n=== Card ${r.cardIndex} ===`);
  console.log("PRICES:", JSON.stringify(r.priceHits, null, 2));
  console.log("AIRLINES:", JSON.stringify(r.airlineHits, null, 2));
  console.log("DURATIONS:", JSON.stringify(r.durationHits, null, 2));
  console.log("STOPS:", JSON.stringify(r.stopHits, null, 2));
  console.log("HTML snippet:", r.snippet);
}

await browser.close();
