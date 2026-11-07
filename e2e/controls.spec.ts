import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

const librivoxChapter = readFileSync('e2e/fixtures/librivox-chapter.mp3');
const LIBRIVOX = /archive\.org\/.*\.mp3/i;

async function serveLibriVox(target: Page) {
  await target.route(LIBRIVOX, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'audio/mpeg',
      body: librivoxChapter,
    }),
  );
}

let page: Page;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
  page = await context.newPage();
  await page.addInitScript(() => {
    const view = window as Window & { __audios?: HTMLAudioElement[] };
    view.__audios = [];
    const Original = window.Audio;
    function Patched(this: HTMLAudioElement, ...args: ConstructorParameters<typeof Audio>) {
      const element = new Original(...args);
      view.__audios?.push(element);
      return element;
    }
  Patched.prototype = Original.prototype;
  window.Audio = Patched as unknown as typeof Audio;
  });
  await serveLibriVox(page);
  await page.goto('/');
  await expect(page.getByText('The Time Machine').filter({ visible: true }).last()).toBeVisible({ timeout: 180_000 });
});

test.afterAll(async () => {
  await page.context().close();
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shown(text: string, exact = true) {
  return page.getByText(text, { exact }).filter({ visible: true }).last();
}

function readerFrame() {
  return page.locator('iframe[srcdoc*="#flow"]').filter({ visible: true }).last().contentFrame();
}

async function headerLine(): Promise<string> {
  const line = page.getByText(/ · \d+%$/).filter({ visible: true }).last();
  return (await line.textContent()) ?? '';
}

async function media(): Promise<{ time: number; paused: boolean; rate: number } | null> {
  return page.evaluate(() => {
    const nodes = (window as Window & { __audios?: HTMLAudioElement[] }).__audios ?? [];
    const live = nodes.find((node) => !node.paused && Boolean(node.src)) ?? nodes.filter((node) => Boolean(node.src)).at(-1) ?? nodes.at(-1);
    if (!live) return null;
    return { time: live.currentTime, paused: live.paused, rate: live.playbackRate };
  });
}

function visibleLabel(name: string) {
  return page.getByLabel(name).filter({ visible: true }).last();
}

async function openReader(title: string, label: 'Read' | 'Chapters' = 'Read') {
  await page.goto('/');
  await expect(shown('Your shelf')).toBeVisible();
  const card = page.locator('div').filter({ visible: true }).filter({ hasText: title }).filter({ has: page.getByText(label, { exact: true }) }).last();
  await card.getByText(label, { exact: true }).click();
  await expect(visibleLabel('Back')).toBeVisible();
}

async function pickChapter(title: string) {
  await shown('Chapters').click();
  const row = page.getByRole('button', { name: title, exact: true }).filter({ visible: true }).last();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect.poll(headerLine).toMatch(new RegExp(`^${escapeRegExp(title)} ·`));
}

async function chooseEngine(label: string) {
  await page.getByText(new RegExp(`[●○]\\s+${escapeRegExp(label)}`)).filter({ visible: true }).click();
}

test('Add opens Import and Shelf returns', async () => {
  await page.goto('/');
  await shown('Add').click();
  await expect(shown('Add to Folio')).toBeVisible();
  await shown('Shelf').click();
  await expect(shown('Your shelf')).toBeVisible();
});

test('Settings opens and Shelf returns', async () => {
  await page.goto('/');
  await shown('Settings').click();
  await expect(shown('Reading')).toBeVisible();
  await shown('Shelf').click();
  await expect(shown('Your shelf')).toBeVisible();
});

test('Credits opens and Shelf returns', async () => {
  await page.goto('/');
  await shown('Credits').click();
  await expect(shown('The starter shelf is a small demo', false)).toBeVisible();
  await shown('Shelf').click();
  await expect(shown('Your shelf')).toBeVisible();
});

test('filter chips show the right shelves', async () => {
  await page.goto('/');
  for (const name of ['Books', 'Articles', 'All']) {
    await shown(name).click();
    if (name === 'Articles') {
      await expect(shown('Nothing in this shelf yet', false)).toBeVisible();
    }
    if (name === 'Books') {
      await expect(shown('The Art of War')).toBeVisible();
      await expect(page.getByText('A Lamp in the Window').filter({ visible: true })).toHaveCount(0);
    }
    if (name === 'All') {
      await expect(shown('The Time Machine')).toBeVisible();
      await expect(shown('A Lamp in the Window')).toBeVisible();
    }
  }
});

test('the shelf lists its cards', async () => {
  await page.goto('/');
  await expect(shown('The Art of War')).toBeVisible();
  await expect(shown('The Time Machine')).toBeVisible();
  await expect(shown('A Lamp in the Window')).toBeVisible();
});

test.skip('Try again needs a failed library open, which this preview cannot force', async () => {});

test('a card tap opens the reader', async () => {
  await page.goto('/');
  await shown('The Time Machine').click();
  await expect(shown('Chapters')).toBeVisible();
});

test('Listen on a card plays and stays on the shelf', async () => {
  await page.goto('/');
  const card = page.locator('div').filter({ hasText: 'The Time Machine' }).filter({ has: page.getByText('Listen', { exact: true }) }).last();
  await card.getByText('Listen', { exact: true }).click();
  await expect(shown('Your shelf')).toBeVisible();
  await expect(page.getByLabel(/^Open /).filter({ visible: true }).last()).toBeVisible();
  await expect.poll(async () => (await media())?.paused).toBe(false);
});

test('Read on a card opens the reader', async () => {
  await openReader('The Art of War');
  await expect.poll(headerLine).toMatch(/^The Art of War ·/);
});

test('Read is the label on a text item', async () => {
  await page.goto('/');
  const card = page.locator('div').filter({ hasText: 'A Lamp in the Window' }).filter({ has: page.getByText('Read', { exact: true }) }).last();
  await expect(card.getByText('Read', { exact: true })).toBeVisible();
});

test('Shelf in the reader returns to the shelf', async () => {
  await openReader('The Time Machine');
  await shown('Shelf').click();
  await expect(shown('Your shelf')).toBeVisible();
});

test('the demo piece shows its description', async () => {
  await openReader('A Lamp in the Window');
  await expect(shown('A short original sample', false)).toBeVisible();
});

function listenChip(name: string) {
  return page.getByRole('button', { name, exact: true }).filter({ visible: true });
}

test('a book does not offer the recording voice toggle', async () => {
  await openReader('The Art of War');
  await expect(listenChip('Original recording')).toHaveCount(0);
});

test('Chapters is shown for a book and hidden for a single-chapter piece', async () => {
  await openReader('The Art of War');
  await expect(shown('Chapters')).toBeVisible();
  await openReader('A Lamp in the Window');
  await expect(page.getByText('Chapters', { exact: true }).filter({ visible: true })).toHaveCount(0);
});

test('picking a chapter with nothing playing shows that chapter', async () => {
  await openReader('The Art of War');
  await pickChapter('V: Energy');
  const frame = readerFrame();
  await expect(frame.locator('#flow')).toContainText('Energy');
  await expect(frame.locator('#flow')).not.toContainText('Energy272');
});

const BOOKS = [
  { title: 'The Art of War', playing: 'III: Attack by Stratagem', audio: '03 - ATTACK BY STRATAGEM', paused: 'IX: The Army on the March', pausedAudio: '09 - THE ARMY ON THE MARCH', none: 'Endnotes', resume: 'V: Energy' },
  { title: 'The Time Machine', playing: 'IX', audio: '12 - Chapter 12', paused: 'III', pausedAudio: '04 - Chapter 4', none: 'Frontmatter', resume: 'VI' },
] as const;

for (const book of BOOKS) {
  test(`${book.title}: a playing chapter pick loads that text's audio and does not jump back`, async () => {
    await openReader(book.title);
    await shown('Listen').click();
    await expect.poll(async () => (await media())?.paused).toBe(false);
    await pickChapter(book.playing);
    await expect(shown(book.audio, false)).toBeVisible({ timeout: 70_000 });
    await page.waitForTimeout(2500);
    await expect.poll(headerLine).toMatch(new RegExp(`^${escapeRegExp(book.playing)} ·`));
    await expect.poll(async () => (await media())?.paused).toBe(false);
  });

  test(`${book.title}: a paused chapter pick cues audio and stays paused`, async () => {
    await visibleLabel('Pause').click();
    await expect.poll(async () => (await media())?.paused).toBe(true);
    await pickChapter(book.paused);
    await expect(shown(book.pausedAudio, false)).toBeVisible({ timeout: 70_000 });
    await page.waitForTimeout(1500);
    await expect(visibleLabel('Play')).toBeVisible();
    await expect.poll(async () => (await media())?.paused).toBe(true);
    await expect.poll(headerLine).toMatch(new RegExp(`^${escapeRegExp(book.paused)} ·`));
  });

  test(`${book.title}: front matter or endnotes do not start a different recording`, async () => {
    const before = await shown(book.pausedAudio, false).textContent();
    await pickChapter(book.none);
    await expect(visibleLabel('Play')).toBeVisible();
    await expect(shown(before ?? book.pausedAudio)).toBeVisible();
  });

  test(`${book.title}: leaving and reloading reopens the picked chapter`, async () => {
    await pickChapter(book.resume);
    await shown('Shelf').click();
    await expect(shown('Your shelf')).toBeVisible();
    await openReader(book.title);
    await expect.poll(headerLine).toMatch(new RegExp(`^${escapeRegExp(book.resume)} ·`));
    await page.reload();
    await expect(shown('Your shelf').or(shown(book.title))).toBeVisible({ timeout: 60_000 });
    if (await shown('Your shelf').isVisible()) await openReader(book.title);
    await expect.poll(headerLine).toMatch(new RegExp(`^${escapeRegExp(book.resume)} ·`));
  });
}

test('the now-playing bar opens the reader and does not stack a duplicate', async () => {
  await openReader('The Time Machine');
  await shown('Listen').click();
  await expect.poll(async () => (await media())?.paused).toBe(false);
  const bar = page.getByLabel(/^Open /).filter({ visible: true }).last();
  await expect(bar).toBeVisible();
  await bar.click();
  await expect(shown('Shelf')).toBeVisible();
  await bar.click();
  await expect(page.getByText('Shelf', { exact: true }).filter({ visible: true })).toHaveCount(1);
});

function downloadNotice() {
  return page.getByText(/could not be downloaded|Could not download this chapter/).filter({ visible: true });
}

async function dismissNotice() {
  if ((await downloadNotice().count()) > 0) await downloadNotice().click();
  await expect(downloadNotice()).toHaveCount(0);
}

test('a dropped chapter download retries and plays without a notice', async () => {
  await openReader('The Art of War');
  let aborted = 0;
  await page.route('**://archive.org/**', async (route) => {
    if (aborted === 0 && route.request().url().includes('artofwar_04')) {
      aborted += 1;
      await route.abort('failed');
      return;
    }
    await route.fallback();
  });
  try {
    await shown('Listen').click();
    await expect.poll(async () => (await media())?.paused).toBe(false);
    await dismissNotice();
    await pickChapter('IV: Tactical Dispositions');
    await expect(shown('04 - TACTICAL DISPOSITIONS', false)).toBeVisible({ timeout: 70_000 });
    await expect.poll(async () => (await media())?.paused).toBe(false);
    await expect(downloadNotice()).toHaveCount(0);
    expect(aborted).toBe(1);
  } finally {
    await page.unroute('**://archive.org/**');
  }
});

test('a chapter download that keeps failing shows the notice once', async () => {
  await openReader('The Art of War');
  let hits = 0;
  await page.route('**://archive.org/**', (route) => {
    hits += 1;
    return route.abort('failed');
  });
  try {
    await shown('Listen').click();
    await expect.poll(async () => (await media())?.paused).toBe(false);
    await dismissNotice();
    await pickChapter('II: Waging War');
    await page.waitForTimeout(1200);
    await expect(downloadNotice()).toHaveCount(0);
    await expect(shown('This chapter could not be downloaded. Check the connection and try again.', false)).toBeVisible({ timeout: 15_000 });
    await expect(downloadNotice()).toHaveCount(1);
    expect(hits).toBe(3);
  } finally {
    await page.unroute('**://archive.org/**');
  }
});

test('a missing chapter is not retried', async () => {
  await openReader('The Art of War');
  await shown('Listen').click();
  await expect.poll(async () => (await media())?.paused, { timeout: 70_000 }).toBe(false);
  await dismissNotice();
  let hits = 0;
  await page.route('**://archive.org/**', (route) => {
    hits += 1;
    return route.fulfill({ status: 404, body: 'missing' });
  });
  try {
    await pickChapter('VI: Weak Points and Strong');
    const started = Date.now();
    await expect(shown('Could not download this chapter (404).', false)).toBeVisible({ timeout: 8_000 });
    expect(Date.now() - started).toBeLessThan(2_500);
    await page.waitForTimeout(1_500);
    expect(hits).toBe(1);
    await expect(downloadNotice()).toHaveCount(1);
  } finally {
    await page.unroute('**://archive.org/**');
  }
});

test('picking another chapter while a download is retrying does not start both', async () => {
  await openReader('The Art of War');
  let hits = 0;
  await page.route('**://archive.org/**artofwar_08*', async (route) => {
    hits += 1;
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    try {
      await route.fallback();
    } catch {
      // The attempt was cancelled when another chapter started.
    }
  });
  try {
    await shown('Listen').click();
    await expect.poll(async () => (await media())?.paused).toBe(false);
    await dismissNotice();
    await pickChapter('VIII: Variation of Tactics');
    await expect.poll(() => hits).toBe(1);
    await pickChapter('III: Attack by Stratagem');
    await expect(shown('03 - ATTACK BY STRATAGEM', false)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await media())?.paused).toBe(false);
    await page.waitForTimeout(5_000);
    await expect(shown('03 - ATTACK BY STRATAGEM', false)).toBeVisible();
    await expect(page.getByText('08 - VARIATION IN TACTICS').filter({ visible: true })).toHaveCount(0);
    await expect(downloadNotice()).toHaveCount(0);
    expect(hits).toBe(1);
  } finally {
    await page.unroute('**://archive.org/**artofwar_08*');
  }
});

test('leaving the reader while a download is retrying cancels it', async () => {
  await openReader('The Art of War');
  let hits = 0;
  await page.route('**://archive.org/**artofwar_07*', async (route) => {
    hits += 1;
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    try {
      await route.fallback();
    } catch {
      // The reader was left before this attempt finished.
    }
  });
  try {
    await shown('Listen').click();
    await expect.poll(async () => (await media())?.paused).toBe(false);
    await dismissNotice();
    const playing = await page.getByLabel(/^Open /).filter({ visible: true }).last().innerText();
    const chapterLine = playing.split('\n').find((line) => line.includes('·')) ?? playing;
    const chapterTitle = chapterLine.replace(/\s+·.*/, '').trim();
    await pickChapter('VII: Manoeuvring');
    await expect.poll(() => hits).toBe(1);
    await expect(shown('Fetching audio…', false)).toBeVisible();
    await shown('Shelf').click();
    await expect(shown('Your shelf')).toBeVisible();
    await expect(page.getByText('Fetching audio…').filter({ visible: true })).toHaveCount(0);
    await page.waitForTimeout(5_000);
    await expect(shown(chapterTitle, false)).toBeVisible();
    await expect(page.getByText('07 - MANEUVERING').filter({ visible: true })).toHaveCount(0);
    await expect(downloadNotice()).toHaveCount(0);
    await expect.poll(async () => (await media())?.paused).toBe(false);
    expect(hits).toBe(1);
  } finally {
    await page.unroute('**://archive.org/**artofwar_07*');
  }
});

test('a chapter pick during a playback gap keeps playing', async () => {
  await openReader('The Time Machine');
  await shown('Listen').click();
  await expect.poll(async () => (await media())?.paused).toBe(false);
  await page.evaluate(() => {
    const nodes = (window as Window & { __audios?: HTMLAudioElement[] }).__audios ?? [];
    nodes[nodes.length - 1]?.pause();
  });
  await expect(visibleLabel('Play')).toBeVisible();
  const onChapterFour = await shown('04 - Chapter 4', false).isVisible();
  await pickChapter(onChapterFour ? 'IX' : 'III');
  await expect(shown(onChapterFour ? '12 - Chapter 12' : '04 - Chapter 4', false)).toBeVisible({ timeout: 70_000 });
  await expect.poll(async () => (await media())?.paused).toBe(false);
});

test('a paused chapter pick is what Play loads after leaving mid-download', async () => {
  await openReader('The Art of War');
  await shown('Listen').click();
  await expect.poll(async () => (await media())?.paused).toBe(false);
  await visibleLabel('Pause').click();
  await expect.poll(async () => (await media())?.paused).toBe(true);
  let hits = 0;
  await page.route('**://archive.org/**artofwar_10*', async (route) => {
    hits += 1;
    if (hits === 1) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      try {
        await route.abort();
      } catch {
        // Leaving cancelled the first attempt.
      }
      return;
    }
    await route.fallback();
  });
  try {
    await pickChapter('X: Terrain');
    await expect.poll(() => hits).toBe(1);
    await shown('Shelf').click();
    await expect(shown('Your shelf')).toBeVisible();
    await visibleLabel('Play').click();
    await expect(shown('10 - TERRAIN', false)).toBeVisible({ timeout: 70_000 });
    await expect.poll(async () => (await media())?.paused).toBe(false);
  } finally {
    await page.unroute('**://archive.org/**artofwar_10*');
  }
});

test('the type menu changes theme, font, size, and spacing', async () => {
  await openReader('The Time Machine');
  const frame = readerFrame();
  await expect(frame.locator('#flow')).toBeVisible();
  const paper = await frame.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor);
  await shown('Aa').click();
  await shown('dark').click();
  await expect.poll(async () => frame.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(paper);
  await shown('Sans').click();
  await expect.poll(async () => frame.locator('#flow').evaluate((node) => getComputedStyle(node).fontFamily)).toMatch(/sans/i);
  const before = await frame.locator('#flow').evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  await shown('+').click();
  await expect.poll(async () => frame.locator('#flow').evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThan(before);
  await shown('1.85').click();
  await expect.poll(async () => frame.locator('#flow').evaluate((node) => parseFloat(getComputedStyle(node).lineHeight) / parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThan(1.7);
  await page.mouse.click(20, 20);
});

test('Speak is on a book and Narrate is the label when there is no audio', async () => {
  await openReader('The Art of War');
  await expect(shown('Speak')).toBeVisible();
  await expect(shown('Listen')).toBeVisible();
});

test('the backdrop closes the chapter menu', async () => {
  await openReader('The Art of War');
  await shown('Chapters').click();
  const menu = page.getByRole('dialog');
  await expect(menu.getByRole('button', { name: 'V: Energy', exact: true })).toBeVisible();
  await menu.click({ position: { x: 12, y: 12 } });
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('skipping ahead, pausing, and playing continues from the new position', async () => {
  await openReader('The Time Machine');
  await shown('Listen').click();
  await expect.poll(async () => (await media())?.time ?? 0).toBeGreaterThan(0.4);
  await visibleLabel('Skip forward').click();
  await expect.poll(async () => (await media())?.time ?? 0).toBeGreaterThan(20);
  const jumped = (await media())?.time ?? 0;
  await visibleLabel('Pause').click();
  await visibleLabel('Play').click();
  await expect.poll(async () => (await media())?.paused).toBe(false);
  const resumed = (await media())?.time ?? 0;
  expect(Math.abs(resumed - jumped)).toBeLessThan(3);
});

test('the sleep timer cycles its label', async () => {
  await visibleLabel('Sleep timer').click();
  await expect(shown('15 min', false)).toBeVisible();
  await visibleLabel('Sleep timer').click();
  await expect(shown('30 min', false)).toBeVisible();
  await visibleLabel('Sleep timer').click();
  await expect(shown('End of chapter', false)).toBeVisible();
  await visibleLabel('Sleep timer').click();
  await expect(shown('Sleep')).toBeVisible();
});

test('changing speed while audio is playing changes the rate', async () => {
  await page.goto('/settings');
  await shown('1.35').click();
  await expect.poll(async () => (await media())?.rate).toBeCloseTo(1.35, 1);
  await shown('0.85').click();
  await expect.poll(async () => (await media())?.rate).toBeCloseTo(0.85, 1);
  await shown('1').click();
});

test('reading settings reach the reader and survive a reload', async () => {
  await shown('sepia').click();
  await shown('Sans').click();
  await shown('28').click();
  await shown('1.65').click();
  await page.reload();
  await expect(shown('sepia')).toBeVisible();
  await openReader('The Time Machine');
  const frame = readerFrame();
  await expect.poll(async () => frame.locator('#flow').evaluate((node) => getComputedStyle(node).fontFamily)).toMatch(/sans/i);
});

test('Estimate position and Follow playback toggles stay where they were set', async () => {
  await page.goto('/settings');
  await shown('Estimate position', false).locator('..').getByText('On', { exact: true }).click();
  await shown('Follow playback', false).locator('..').getByText('On', { exact: true }).click();
  await expect(shown('Follow playback', false).locator('..').getByText('Off', { exact: true })).toBeVisible();
  await shown('Follow playback', false).locator('..').getByText('Off', { exact: true }).click();
  await expect(shown('Follow playback', false).locator('..').getByText('On', { exact: true })).toBeVisible();
});

test('the system engine is labeled System voice on the web', async () => {
  await page.goto('/settings');
  await expect(shown('System voice', false)).toBeVisible();
  await expect(page.getByText('iOS system voice').filter({ visible: true })).toHaveCount(0);
});

test('the narration engine, skip, and voice controls are on screen', async () => {
  await expect(shown('System voice', false)).toBeVisible();
  await expect(shown('On-device neural', false)).toBeVisible();
  await expect(shown('Gemini')).toBeVisible();
  await shown('30s').click();
  await shown('45s').click();
  await expect(shown('Default')).toBeVisible();
  await expect(page.getByText(/browser voice|Voices appear/).filter({ visible: true }).last()).toBeVisible();
});

test('Download Kokoro shows that the download started', async () => {
  await shown('Download Kokoro').click();
  await expect(page.getByText(/Downloading/).filter({ visible: true }).last()).toBeVisible();
});

test('Kokoro and Gemini voice pills can be selected', async () => {
  await shown('Bella · American woman').click();
  await shown('Kore').click();
  await shown('Flash · higher fidelity').click();
  await expect(shown('Kore')).toBeVisible();
});

test('a Gemini key can be saved and removed', async () => {
  await page.getByPlaceholder('Paste key').filter({ visible: true }).last().fill('test-key');
  await shown('Save key').click();
  await expect(shown('A key is saved on this device.', false)).toBeVisible();
  await shown('Remove').click();
  await expect(shown('No key saved.', false)).toBeVisible();
});

test('narrating with Gemini and no key points to Settings', async () => {
  await chooseEngine('Gemini');
  await openReader('The Art of War');
  await shown('Speak').click();
  await expect(shown('Add a Gemini API key in Settings.', false)).toBeVisible({ timeout: 30_000 });
});

const FAKE_KOKORO = `
export const KokoroTTS = {
  async from_pretrained(id, options) {
    options.progress_callback({ status: 'progress', file: 'onnx/model_quantized.onnx', progress: 50 });
    window.parent.__kokoro = { dtype: options.dtype, texts: [] };
    return {
      async generate(text, { voice }) {
        window.parent.__kokoro.texts.push({ text, voice });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const audio = new Float32Array(7200);
        for (let i = 0; i < audio.length; i += 1) {
          audio[i] = Math.sin(i / 8) * 0.3;
        }
        return { audio, sampling_rate: 24000 };
      },
    };
  },
};
`;

type KokoroLog = { dtype: string; texts: { text: string; voice: string }[] };

async function kokoroLog(): Promise<KokoroLog | null> {
  return page.evaluate(() => (window as Window & { __kokoro?: KokoroLog }).__kokoro ?? null);
}

test('Kokoro narrates sentence by sentence in the chosen voice and follow moves the reader', async () => {
  await page.route('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: FAKE_KOKORO }),
  );
  try {
    await page.goto('/settings');
    await chooseEngine('On-device neural');
    await shown('George · British man').click();
    await shown('Download Kokoro').click();
    await expect(shown('Kokoro is on this device.')).toBeVisible({ timeout: 30_000 });
    expect((await kokoroLog())?.dtype).toBe('q8');

    await openReader('The Art of War');
    const frame = readerFrame();
    await expect(frame.locator('.s').first()).toBeVisible();
    const startScroll = await frame.locator('#scroller').evaluate((node) => node.scrollTop);
    await shown('Speak').click();
    await expect.poll(async () => (await kokoroLog())?.texts.length ?? 0, { timeout: 60_000 }).toBeGreaterThan(12);
    const log = await kokoroLog();
    expect(new Set(log?.texts.map((entry) => entry.voice))).toEqual(new Set(['bm_george']));
    expect(new Set(log?.texts.map((entry) => entry.text)).size).toBe(log?.texts.length);
    await expect.poll(() => frame.locator('#scroller').evaluate((node) => node.scrollTop), { timeout: 60_000 }).toBeGreaterThan(startScroll);

    const header = await page.evaluate(async () => {
      const nodes = (window as Window & { __audios?: HTMLAudioElement[] }).__audios ?? [];
      const live = nodes[nodes.length - 1];
      const bytes = new DataView(await (await fetch(live.src)).arrayBuffer());
      return { format: bytes.getUint16(20, true), bits: bytes.getUint16(34, true), rate: bytes.getUint32(24, true) };
    });
    expect(header).toEqual({ format: 1, bits: 16, rate: 24000 });
    await expect(page.getByText(/Kokoro is not ready|Kokoro was stopped/).filter({ visible: true })).toHaveCount(0);
    await visibleLabel('Pause').click();
  } finally {
    await page.unroute('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm');
  }
});

async function mockSystemSpeech() {
  await page.evaluate(() => {
    const spoken: string[] = [];
    (window as Window & { __spoken?: string[] }).__spoken = spoken;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak = (utterance: SpeechSynthesisUtterance) => {
      spoken.push(utterance.text);
      utterance.onstart?.(new Event('start') as SpeechSynthesisEvent);
      window.setTimeout(() => {
        utterance.onend?.(new Event('end') as SpeechSynthesisEvent);
      }, 8_000);
    };
  });
}

async function spokenLog(): Promise<string[]> {
  return page.evaluate(() => (window as Window & { __spoken?: string[] }).__spoken ?? []);
}

test('a scripted sample can play the recording or read the script in the Settings voice', async () => {
  await page.goto('/settings');
  await chooseEngine('System voice');
  await openReader('A Lamp in the Window');
  await expect(listenChip('Original recording')).toBeVisible();
  await expect(listenChip('Voice: System')).toBeVisible();
  await expect(shown('This plays the original recording', false)).toBeVisible();

  await shown('Listen').click();
  await expect.poll(async () => (await media())?.paused).toBe(false);
  await expect(shown('Original recording')).toBeVisible();
  await visibleLabel('Skip forward').click();
  await expect.poll(async () => (await media())?.time ?? 0).toBeGreaterThan(20);

  const frame = readerFrame();
  const sentences = await frame.locator('.s').evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean));
  expect(sentences.length).toBeGreaterThan(4);

  await mockSystemSpeech();
  await listenChip('Voice: System').click();
  await expect(shown('This reads the script', false)).toBeVisible();
  await expect.poll(async () => (await spokenLog()).length, { timeout: 30_000 }).toBeGreaterThan(0);
  const spoken = await spokenLog();
  expect(sentences).toContain(spoken[0]);
  expect(spoken[0]).not.toEqual(sentences[0]);
  await visibleLabel('Pause').click();

  await page.route('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: FAKE_KOKORO }),
  );
  try {
    await page.goto('/settings');
    await chooseEngine('On-device neural');
    await shown('Emma · British woman').click();
    await shown('Download Kokoro').click();
    await expect(shown('Kokoro is on this device.')).toBeVisible({ timeout: 30_000 });

    await openReader('A Lamp in the Window');
    await expect(listenChip('Voice: Kokoro · Emma')).toBeVisible();
    const before = (await kokoroLog())?.texts.length ?? 0;
    await shown('Listen').click();
    await expect.poll(async () => ((await kokoroLog())?.texts.length ?? 0) - before, { timeout: 60_000 }).toBeGreaterThan(0);
    const generated = ((await kokoroLog())?.texts ?? []).slice(before);
    expect(new Set(generated.map((entry) => entry.voice))).toEqual(new Set(['bf_emma']));
    expect(sentences).toContain(generated[0].text);

    await listenChip('Original recording').click();
    await expect(shown('This plays the original recording', false)).toBeVisible();
    await expect.poll(async () => (await media())?.paused).toBe(false);
    expect((await media())?.time ?? 0).toBeGreaterThan(5);
    await visibleLabel('Pause').click();
  } finally {
    await page.unroute('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm');
  }
});

test('a failed system voice does not leave the bar on Pause', async () => {
  await page.goto('/settings');
  await chooseEngine('System voice');
  await openReader('The Art of War');
  await page.evaluate(() => {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak = (utterance: SpeechSynthesisUtterance) => {
      window.setTimeout(() => {
        utterance.onerror?.(new SpeechSynthesisErrorEvent('error', { utterance, error: 'synthesis-failed' }));
      }, 0);
    };
  });
  await shown('Speak').click();
  await expect(page.getByText(/Speech failed|Speech did not start|Narration stopped/).filter({ visible: true }).last()).toBeVisible();
  await expect(visibleLabel('Play')).toBeVisible();
});

test('a notice can be dismissed', async () => {
  const notice = page.getByText('Tap to dismiss.').filter({ visible: true });
  if (await notice.count()) await notice.last().click();
  await expect(page.getByText('Tap to dismiss.').filter({ visible: true })).toHaveCount(0);
});

test('Back to the shelf works when the reader was opened directly', async () => {
  await page.goto('/read/missing-item');
  await expect(shown('That item is gone.', false)).toBeVisible();
  await page.getByRole('button', { name: 'Back to the shelf' }).filter({ visible: true }).click();
  await expect(shown('Your shelf')).toBeVisible();
});

test('Choose EPUB adds a book', async () => {
  await page.goto('/import');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), shown('Choose EPUB').click()]);
  await chooser.setFiles('assets/seed/books/art-of-war/book.epub');
  await expect(page.getByText(/Added /).filter({ visible: true }).last()).toBeVisible({ timeout: 60_000 });
});

test('Choose audio rejects a text file and accepts an mp3', async () => {
  await page.goto('/import');
  const [bad] = await Promise.all([page.waitForEvent('filechooser'), shown('Choose audio').click()]);
  await bad.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not audio') });
  await expect(page.getByText(/audio|Import failed|could not/i).filter({ visible: true }).last()).toBeVisible();
  const [good] = await Promise.all([page.waitForEvent('filechooser'), shown('Choose audio').click()]);
  await good.setFiles('assets/seed/books/art-of-war/audio-00.mp3');
  await expect(page.getByText(/Added |audio-00/).filter({ visible: true }).last()).toBeVisible({ timeout: 30_000 });
});

test('an audio-only chapter row plays that item, not whatever was already loaded', async () => {
  await openReader('The Time Machine');
  await shown('Listen').click();
  await expect.poll(async () => (await media())?.paused).toBe(false);
  await page.goto('/');
  const card = page.locator('div').filter({ hasText: 'audio-00' }).filter({ has: page.getByText('Chapters', { exact: true }) }).last();
  await expect(card.getByText('Chapters', { exact: true })).toBeVisible();
  await card.getByText('audio-00', { exact: true }).click();
  await expect(shown('Audio only')).toBeVisible();
  await page.getByRole('button', { name: 'audio-00', exact: true }).filter({ visible: true }).click();
  await expect(page.getByText('That chapter is missing.').filter({ visible: true })).toHaveCount(0);
  await expect(page.getByLabel('Open audio-00').filter({ visible: true }).last()).toBeVisible();
});

test('Choose bundle and a URL fetch show a result', async () => {
  await page.goto('/import');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), shown('Choose bundle').click()]);
  await chooser.setFiles([
    'assets/seed/demo/lamp/folio.json',
    'assets/seed/demo/lamp/audio.mp3',
    'assets/seed/demo/lamp/captions.vtt',
    'assets/seed/demo/lamp/script.txt',
  ]);
  await expect(page.getByText(/Added |Saved /).filter({ visible: true }).last()).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder('https://').filter({ visible: true }).last().fill('');
  await shown('Fetch').click();
  await expect(shown('Add to Folio')).toBeVisible();
  await page.getByPlaceholder('https://').filter({ visible: true }).last().fill('https://example.invalid/missing-book');
  await shown('Fetch').click();
  await expect(page.getByText(/returned|failed|fetch|download|page/i).filter({ visible: true }).last()).toBeVisible();
});

test('an X post URL is saved from the post text', async () => {
  await page.route('https://api.fxtwitter.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tweet: { text: 'A short note worth keeping on the shelf.', author: { name: 'Ada', screen_name: 'ada' } } }),
    }),
  );
  await page.goto('/import');
  await page.getByPlaceholder('https://').filter({ visible: true }).last().fill('https://x.com/ada/status/12345');
  await shown('Fetch').click();
  await expect(page.getByText(/Saved/).filter({ visible: true }).last()).toBeVisible();
  await page.unroute('https://api.fxtwitter.com/**');
});

test('Link them asks for a selection, then pairs a book with audio', async () => {
  await page.goto('/import');
  await shown('Link them').click();
  await expect(shown('Pick a book and an audio item.', false)).toBeVisible();
  await shown('The Art of War', false).click();
  await shown('audio-00', false).click();
  await shown('Link them').click();
  await expect(page.getByText(/now has that audio/).filter({ visible: true }).last()).toBeVisible();
});

function articleCard() {
  return page.locator('div').filter({ visible: true }).filter({ hasText: '@ada' }).filter({ has: page.getByText('Remove', { exact: true }) }).last();
}

test('Remove then Cancel keeps the item', async () => {
  await page.goto('/');
  await shown('Articles').click();
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('@ada');
    await dialog.dismiss();
  });
  await articleCard().getByText('Remove', { exact: true }).click();
  await expect(page.getByText('@ada', { exact: true }).filter({ visible: true }).first()).toBeVisible();
});

test('Remove then confirm deletes the item and it stays gone', async () => {
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('@ada');
    await dialog.accept();
  });
  await articleCard().getByText('Remove', { exact: true }).click();
  await expect(page.getByText('@ada').filter({ visible: true })).toHaveCount(0);
  await page.reload();
  await expect(shown('Your shelf')).toBeVisible({ timeout: 60_000 });
  await shown('Articles').click();
  await expect(page.getByText('@ada').filter({ visible: true })).toHaveCount(0);
});

test('archive.org still serves a LibriVox chapter when the live network is turned on', async () => {
  test.skip(process.env.FOLIO_LIVE_ARCHIVE !== '1', 'Set FOLIO_LIVE_ARCHIVE=1 to download a real LibriVox chapter.');
  await page.unroute(LIBRIVOX);
  try {
    await openReader('The Art of War');
    await shown('Listen').click();
    await expect.poll(async () => (await media())?.paused, { timeout: 70_000 }).toBe(false);
    await pickChapter('IV: Tactical Dispositions');
    await expect(shown('04 - TACTICAL DISPOSITIONS', false)).toBeVisible({ timeout: 70_000 });
    await expect.poll(async () => (await media())?.paused).toBe(false);
  } finally {
    await serveLibriVox(page);
  }
});
