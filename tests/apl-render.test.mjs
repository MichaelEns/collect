import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import doorables from '../alexa/lambda/doorables.js';
import { handleAlexaEnvelope } from '../worker/src/alexa.js';
import { aplRenderer } from './helpers/apl-renderer.mjs';

const FAMILY_CODE = 'foxglove-lizard-donut-donut';
const SET_ID = 'sw-galaxy-peek-s2';
const SKILL_ID = 'amzn1.ask.skill.00cc0524-8f23-4c1b-b8a9-1b20e6d1631c';
const queryService = new doorables.DoorablesService({
  dataBase: 'https://catalogue.example',
  fetch: async (url) => new Response(fs.readFileSync(
    new URL(`../sets/${new URL(url).pathname.slice(1)}`, import.meta.url),
    'utf8',
  )),
});

function request(request) {
  return {
    session: {
      application: { applicationId: SKILL_ID },
      user: { userId: 'apl-render-test-user' },
    },
    context: {
      System: {
        user: { userId: 'apl-render-test-user' },
        device: { supportedInterfaces: { 'Alexa.Presentation.APL': {} } },
      },
    },
    request,
  };
}

async function assertOnScreen(locator, viewport) {
  assert.equal(await locator.count(), 1);
  assert.equal(await locator.isVisible(), true);
  const box = await locator.boundingBox();
  assert.ok(box.width > 0 && box.height > 0);
  assert.ok(box.x >= 0 && box.y >= 0);
  assert.ok(box.x + box.width <= viewport.width + 1);
  assert.ok(box.y + box.height <= viewport.height + 1);
}

async function screenshot(page, name) {
  if (process.env.COLLECT_APL_SCREENSHOT_DIR) {
    await page.screenshot({
      path: path.join(process.env.COLLECT_APL_SCREENSHOT_DIR, `${name}.png`),
    });
  }
}

for (const viewport of [{ width: 960, height: 480 }, { width: 1280, height: 800 }]) {
  test(`Echo Show renders and edits the collection at ${viewport.width}x${viewport.height}`, {
    timeout: 60000,
  }, async (t) => {
    const { page, render, errors } = await aplRenderer(t, viewport);
    const values = new Map([[`p:${FAMILY_CODE}`, '{}']]);
    const env = {
      COLLECT: {
        get: async (key) => values.get(key) ?? null,
        put: async (key, value) => { values.set(key, value); },
      },
    };
    await handleAlexaEnvelope(request({
      type: 'IntentRequest',
      intent: {
        name: 'LinkCollectionIntent',
        slots: { familyCode: { value: FAMILY_CODE } },
      },
    }), env, queryService);
    const launch = await handleAlexaEnvelope(
      request({ type: 'LaunchRequest' }), env, queryService,
    );
    await render(launch.response.directives[0]);
    await assertOnScreen(page.getByText("Joe's Collection", { exact: true }), viewport);
    await assertOnScreen(page.getByText('Galaxy Peek Series 2', { exact: true }), viewport);
    assert.equal(await page.locator(`[data-componentid="set-card-${SET_ID}"]`).evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ), 'rgb(32, 42, 89)');
    await screenshot(page, `echo-dashboard-${viewport.width}`);

    await page.getByText('Galaxy Peek Series 2', { exact: true }).tap();
    await page.waitForFunction(() => window.aplEvents.length > 0);
    assert.deepEqual(await page.evaluate(() => window.aplEvents), [['openSet', SET_ID]]);
    const opened = await handleAlexaEnvelope(request({
      type: 'Alexa.Presentation.APL.UserEvent',
      arguments: await page.evaluate(() => window.aplEvents[0]),
    }), env, queryService);
    await render(opened.response.directives[0]);
    const figure = page.getByText('Anakin Skywalker (young)', { exact: true });
    await assertOnScreen(figure, viewport);
    await assertOnScreen(page.getByText('AS', { exact: true }).first(), viewport);
    const first = await page.locator('[data-componentid="figure-card-anakin-young"]').boundingBox();
    const second = await page.locator('[data-componentid="figure-card-anakin-padawan"]').boundingBox();
    const fourth = await page.locator('[data-componentid="figure-card-omega"]').boundingBox();
    assert.ok(Math.abs(first.y - second.y) <= 2, 'figure cards must form a horizontal grid row');
    assert.ok(second.x > first.x, 'the second figure must be to the right of the first');
    assert.equal(fourth.y, first.y, 'four figures must fit across the first row');
    assert.ok(fourth.x > second.x);
    assert.equal(await page.getByText('Missing', { exact: true }).count(), 25);
    await screenshot(page, `echo-figures-${viewport.width}`);

    await figure.tap();
    await page.waitForFunction(() => window.aplEvents.length > 0);
    assert.deepEqual(await page.evaluate(() => window.aplEvents), [
      ['toggleFigure', SET_ID, 'anakin-young'],
    ]);
    const toggled = await handleAlexaEnvelope(request({
      type: 'Alexa.Presentation.APL.UserEvent',
      arguments: await page.evaluate(() => window.aplEvents[0]),
    }), env, queryService);
    await render(toggled.response.directives[0]);
    await assertOnScreen(page.getByText('✓ Found', { exact: true }), viewport);
    assert.equal(await page.locator('[data-componentid="figure-card-anakin-young"]').evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ), 'rgb(23, 77, 53)');
    assert.equal(JSON.parse(values.get(`p:${FAMILY_CODE}`))[SET_ID]['anakin-young'].have, true);

    const lastFigure = toggled.response.directives[0].datasources.collection.figures.at(-1);
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.wheel(0, viewport.height * 3);
    await page.waitForFunction((element) => {
      const box = element.getBoundingClientRect();
      return box.y > 0 && box.bottom <= innerHeight;
    }, await page.getByText(lastFigure.name, { exact: true }).elementHandle());
    await assertOnScreen(page.getByText(lastFigure.name, { exact: true }), viewport);
    await page.getByText(lastFigure.name, { exact: true }).tap();
    await page.waitForFunction(() => window.aplEvents.length > 0);
    assert.deepEqual(await page.evaluate(() => window.aplEvents[0]), [
      'toggleFigure', SET_ID, lastFigure.id,
    ]);

    await page.getByText('‹', { exact: true }).tap();
    await page.waitForFunction(() => window.aplEvents.length >= 2);
    assert.deepEqual(await page.evaluate(() => window.aplEvents[1]), ['dashboard']);
    const back = await handleAlexaEnvelope(request({
      type: 'Alexa.Presentation.APL.UserEvent',
      arguments: ['dashboard'],
    }), env, queryService);
    await render(back.response.directives[0]);
    await assertOnScreen(page.getByText("Joe's Collection", { exact: true }), viewport);
    const lastSet = back.response.directives[0].datasources.collection.sets.at(-1);
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.wheel(0, viewport.height * 3);
    await page.waitForFunction((element) => {
      const box = element.getBoundingClientRect();
      return box.y > 0 && box.bottom <= innerHeight;
    }, await page.getByText(lastSet.name, { exact: true }).elementHandle());
    await assertOnScreen(page.getByText(lastSet.name, { exact: true }), viewport);
    await page.getByText(lastSet.name, { exact: true }).tap();
    await page.waitForFunction(() => window.aplEvents.length > 0);
    assert.deepEqual(await page.evaluate(() => window.aplEvents[0]), ['openSet', lastSet.id]);
    assert.deepEqual(await page.evaluate(() => window.aplErrors), []);
    assert.deepEqual(errors, []);
  });
}

test('private photos render and missing photos leave figure initials visible', {
  timeout: 60000,
}, async (t) => {
  const viewport = { width: 960, height: 480 };
  const { page, render, errors } = await aplRenderer(t, viewport);
  let imageRequests = 0;
  await page.route('https://images.example/**', async (route) => {
    imageRequests += 1;
    if (new URL(route.request().url()).pathname.endsWith('/anakin-young')) {
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#ffc93d"/></svg>',
      });
    } else {
      await route.fulfill({ status: 404, body: 'No image.' });
    }
  });
  const response = await handleAlexaEnvelope(request({
    type: 'Alexa.Presentation.APL.UserEvent',
    arguments: ['openSet', SET_ID],
  }), {
    COLLECT: { get: async (key) => key.startsWith('alexa-user:') ? FAMILY_CODE : '{}' },
    ALEXA_IMAGE_SIGNING_KEY: 'render-test-private-image-key',
    PUBLIC_BASE_URL: 'https://images.example',
  }, queryService);
  const directive = response.response.directives[0];
  await render({
    ...directive,
    datasources: {
      collection: {
        ...directive.datasources.collection,
        figures: directive.datasources.collection.figures.map((figure) => ({
          ...figure,
          image: '',
        })),
      },
    },
  });
  const initials = page.getByText('AS', { exact: true });
  const noPhoto = await initials.first().screenshot();
  const fallback = await initials.nth(1).screenshot();
  const failedImage = page.waitForResponse((response) => response.status() === 404);
  await render(directive);
  await failedImage;
  const photo = page.locator('[data-componentid="photo-anakin-young"]');
  await photo.locator('image').waitFor();
  await page.waitForFunction((element) => Boolean(element.querySelector('image').getAttribute('href')),
    await photo.elementHandle());
  await assertOnScreen(photo, viewport);
  await assertOnScreen(initials.nth(1), viewport);
  assert.deepEqual(await initials.nth(1).screenshot(), fallback,
    'a failed image must not cover the initials fallback');
  assert.notDeepEqual(await initials.first().screenshot(), noPhoto,
    'the loaded image must replace the initials visually');
  await assertOnScreen(page.getByText('Anakin Skywalker (young)', { exact: true }), viewport);
  assert.ok(imageRequests > 0);
  assert.deepEqual(errors, []);
});

test('the widget renders default and Data Store summary text', {
  timeout: 60000,
}, async (t) => {
  const viewport = { width: 328, height: 552 };
  const { page, render, errors } = await aplRenderer(t, viewport);
  const base = new URL('../alexa/skill-package/dataStorePackages/JoesCollectionSummary/', import.meta.url);
  const directive = {
    document: JSON.parse(fs.readFileSync(new URL('documents/document.json', base), 'utf8')),
    datasources: JSON.parse(fs.readFileSync(new URL('datasources/default.json', base), 'utf8')),
  };
  await render(directive);
  await assertOnScreen(page.getByText("Joe's Collection", { exact: true }), viewport);
  await assertOnScreen(page.getByText('Open the skill to link a collection', { exact: true }), viewport);
  await render(directive, { title: "Joe's Collection", progress: '12 of 25 found' });
  await assertOnScreen(page.getByText('12 of 25 found', { exact: true }), viewport);
  await page.getByText('Tap to open the checklist', { exact: true }).tap();
  await page.waitForFunction(() => window.aplEvents.length > 0);
  assert.deepEqual(await page.evaluate(() => window.aplEvents), [['dashboard']]);
  assert.deepEqual(errors, []);
});
