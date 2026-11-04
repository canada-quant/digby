/**
 * Real-browser verification of the per-wake accordion fix (platform task
 * 2026-09-03). Drives headless Chromium against the dev harness page and
 * asserts each acceptance criterion, capturing before/after screenshots at
 * desktop + mobile widths. Run: node scripts/dev/accordion-verify.mjs
 *
 * Selector notes: GROUP accordion buttons are scoped by their "· N item(s)"
 * label text (MachineWakeBlock rows inside expanded groups have their own
 * aria-expanded buttons); expanded summary notes are located by the <strong>
 * headline their markdown renders ("Fleet wake — …") — accordion labels are
 * plain text, never <strong>.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:3100/dev-accordion-harness';
const OUT = new URL('../../../docs/pr-artifacts/2026-09-03-accordion-per-wake/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const GROUP = 'button[aria-expanded]:has-text("item")';
const LEGACY_GROUP = 'button[aria-expanded]:has-text("machine turn")';
const SUMMARY_BODY = 'strong:has-text("Fleet wake")';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();

async function loadPage({ width, height, legacy = false }) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${BASE}${legacy ? '?legacy=1' : ''}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=DEV HARNESS', { timeout: 60_000 });
  await page.waitForTimeout(2500); // markdown/highlight settle + cold-open pin
  return page;
}

/* ── BEFORE (legacy #604 behavior), desktop ─────────────────────────────── */
{
  const page = await loadPage({ width: 1280, height: 900, legacy: true });
  const groupCount = await page.locator(LEGACY_GROUP).count();
  const firstLabel = (await page.locator(LEGACY_GROUP).first().innerText()).replace(/\s+/g, ' ').slice(0, 110);
  const buried = await page.locator(SUMMARY_BODY).count();
  check('BEFORE: legacy merges wakes into cross-run accordions', groupCount <= 3, `${groupCount} accordion(s) spanning 7 wakes — first: "${firstLabel}"`);
  check('BEFORE: summary notes buried (none expanded)', buried === 0, `${buried} expanded summary notes`);
  await page.screenshot({ path: `${OUT}/before-desktop-collapsed.png` });
  await page.locator(LEGACY_GROUP).first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/before-desktop-expanded.png` });
  await page.close();
}

/* ── AFTER (fixed), desktop ─────────────────────────────────────────────── */
{
  const page = await loadPage({ width: 1280, height: 900 });
  const groups = page.locator(GROUP);
  const groupCount = await groups.count();
  check('AFTER: one accordion PER WAKE (never a cross-run mega-accordion)', groupCount === 7, `${groupCount} accordions for 7 wakes`);

  // (1) Zero-click summaries: every wake's summary note is expanded markdown.
  //     5 headline "Fleet wake — …", the continuation's headlines "Continuation
  //     — …" — 6 wakes with summaries in total.
  const summaries = await page.locator(SUMMARY_BODY).count();
  const contSummaries = await page.locator('strong:has-text("Continuation — deploy watch green")').count();
  check('AFTER: every summary note renders expanded (zero clicks)', summaries + contSummaries === 6, `${summaries}+${contSummaries} expanded summary notes (6 wakes with summaries)`);
  check('AFTER: newest summary readable without a click',
    await page.locator('text=Fleet wake — quiet hour, all lanes idle').first().isVisible());

  // (5) Cold-open: scroller pinned at the bottom (newest summary in view) —
  //     measured BEFORE any clicking (clicks scroll groups into view).
  const atBottom = await page.evaluate(() => {
    const s = document.querySelector('.overflow-y-auto');
    return s ? s.scrollHeight - s.scrollTop - s.clientHeight < 40 : false;
  });
  check('AFTER: cold-open lands on the newest summary (scroller at bottom)', atBottom);

  // (3) Scannable labels: time + the run's own headline + hidden count. The
  //     chrome-only wake falls back to its wake event summary instead.
  const labels = await groups.allInnerTexts();
  const labelOk = labels.every(l => /AM|PM/.test(l) && /items? hidden/.test(l));
  const headlineLabels = labels.filter(l => l.includes('Fleet wake') || l.includes('Continuation — deploy watch')).length;
  const fallbackLabel = labels.some(l => l.includes('attention_needed'));
  check('AFTER: labels carry time + headline + count', labelOk && headlineLabels === 6 && fallbackLabel,
    `${headlineLabels}/7 headline labels (+1 event fallback); sample: "${labels[0].replace(/\s+/g, ' ').slice(0, 100)}"`);

  // (2) Per-wake expand: ONE accordion reveals ONLY that wake's chrome rows.
  await groups.nth(0).click();
  await page.waitForTimeout(400);
  const revealed = await page.locator('button[aria-expanded="true"] + div > div').count();
  const stillCollapsed = await page.locator('button[aria-expanded="false"]:has-text("item")').count();
  check('AFTER: one accordion expand shows ONLY that wake', revealed === 3 && stillCollapsed === 6,
    `${revealed} rows revealed (wake 1: envelope+relay+verifier), ${stillCollapsed}/6 other groups still collapsed`);
  await page.screenshot({ path: `${OUT}/after-desktop-one-expanded.png` });
  await groups.nth(0).click();

  // (6) Keyboard access: focus + Enter toggles the accordion.
  await groups.nth(1).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('AFTER: keyboard (Enter) toggles the accordion', await groups.nth(1).getAttribute('aria-expanded') === 'true');
  await page.keyboard.press('Enter');

  await page.screenshot({ path: `${OUT}/after-desktop-collapsed.png` });

  // (4) Rail: owner-row ticks present at desktop width.
  const ticks = await page.locator('button[aria-label^="Jump to your message"]').count();
  check('AFTER: jump rail ticks present (desktop)', ticks === 2, `${ticks} ticks`);
  await page.close();
}

/* ── AFTER, mobile width ────────────────────────────────────────────────── */
{
  const page = await loadPage({ width: 390, height: 844 });
  const groups = page.locator(GROUP);
  check('AFTER(mobile): per-wake accordions at 390px', (await groups.count()) === 7);
  const mSum = await page.locator(SUMMARY_BODY).count();
  const mCont = await page.locator('strong:has-text("Continuation — deploy watch green")').count();
  check('AFTER(mobile): summaries expanded zero-click', mSum + mCont === 6, `${mSum}+${mCont}`);
  const ticks = await page.locator('button[aria-label^="Jump to your message"]').count();
  check('AFTER(mobile): jump rail ticks present (mobile)', ticks === 2, `${ticks} ticks`);
  await page.screenshot({ path: `${OUT}/after-mobile-collapsed.png` });
  await groups.nth(1).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/after-mobile-one-expanded.png` });
  await page.locator('button[aria-label^="Jump to your message"]').first().click({ force: true });
  await page.waitForTimeout(900);
  check('AFTER(mobile): rail tap scrolls the owner message into view',
    await page.locator('text=looks good — keep an eye on the waiver lane tonight').first().isVisible());
  await page.close();
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed — screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
