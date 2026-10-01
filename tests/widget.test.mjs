import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  updateCollectionWidget,
  widgetSummary,
} from '../worker/src/widget.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACKAGE = path.join(
  ROOT,
  'alexa',
  'skill-package',
  'dataStorePackages',
  'JoesCollectionSummary',
);

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(PACKAGE, relative), 'utf8'));
}

function pngSize(relative) {
  const bytes = fs.readFileSync(path.join(ROOT, relative));
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

const queryService = {
  async collectionSets(progress) {
    return [{
      found: progress.set.figure.have ? 1 : 0,
      total: 2,
    }];
  },
};

test('the widget package references a data-bound APL document', () => {
  const manifest = readJson('manifest.json');
  const presentation = readJson('presentations/default.tpl');
  const document = readJson('documents/document.json');
  assert.equal(manifest.packageType, 'APL_PACKAGE');
  assert.equal(manifest.manifest.id, 'JoesCollectionSummary');
  assert.equal(manifest.manifest.installStateChanges, 'INFORM');
  assert.equal(presentation.documentUrl, 'documents/document.json');
  assert.equal(presentation.datasourceUrl, 'datasources/default.json');
  assert.equal(document.extensions[0].uri, 'alexaext:datastore:10');
  assert.equal(
    document.settings.DataStore.dataBindings[0].namespace,
    'JoesCollection',
  );
});

test('widget gallery images have Amazon-required dimensions', () => {
  assert.deepEqual(
    pngSize('alexa/widget-icon-450.png'),
    { width: 450, height: 450 },
  );
  assert.deepEqual(
    pngSize('alexa/widget-preview-328x552.png'),
    { width: 328, height: 552 },
  );
});

test('widget summary reflects the selected collection only', async () => {
  assert.deepEqual(
    await widgetSummary(
      queryService,
      { set: { figure: { have: true } } },
      { name: "Grandma's House" },
    ),
    {
      title: "Grandma's House",
      progress: '1 of 2 found',
      found: 1,
      total: 2,
    },
  );
});

test('widget updates target the Alexa user data store', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/auth/o2/token')) {
      return new Response(JSON.stringify({
        access_token: 'test-token',
        expires_in: 3600,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ results: [{ type: 'SUCCESS' }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const updated = await updateCollectionWidget(
      {
        context: {
          System: {
            user: { userId: 'amzn1.ask.account.family' },
          },
        },
      },
      {
        ALEXA_CLIENT_ID: 'client-id',
        ALEXA_CLIENT_SECRET: 'client-secret',
        ALEXA_DATASTORE_ENDPOINT: 'https://api.example',
      },
      queryService,
      { set: { figure: { have: true } } },
      { name: "Joe's Collection" },
    );
    assert.equal(updated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.example/v1/datastore/commands');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-token');
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body.target, {
    type: 'USER',
    id: 'amzn1.ask.account.family',
  });
  assert.deepEqual(body.commands[0], {
    type: 'PUT_OBJECT',
    namespace: 'JoesCollection',
    key: 'summary',
    content: {
      title: "Joe's Collection",
      progress: '1 of 2 found',
      found: 1,
      total: 2,
    },
  });
});
