import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../worker/package.json', import.meta.url));
const { chromium } = require('playwright');
const engine = fs.readFileSync(require.resolve('apl-viewhost-web'), 'utf8');

export async function aplRenderer(t, viewport) {
  const browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport, hasTouch: true });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<style>body { margin: 0; }</style><div id="apl"></div>');
  await page.addScriptTag({
    content: `${engine}\nwindow.aplReady = AplRenderer.initEngine();`,
  });
  await page.evaluate(() => window.aplReady);

  async function render(directive, summary = null) {
    await page.evaluate(async ({ document, datasources, viewport, summary }) => {
      if (window.renderer) window.renderer.destroy();
      window.aplEvents = [];
      window.aplErrors ||= [];
      const content = AplRenderer.Content.create(
        JSON.stringify(document),
        JSON.stringify(datasources),
      );
      const extensionManager = new AplRenderer.ExtensionManager();
      if (summary) {
        const data = AplRenderer.LiveMap.create(summary);
        let name;
        extensionManager.addExtension({
          getUri: () => 'alexaext:datastore:10',
          getEnvironment: () => ({}),
          getExtensionCommands: () => [],
          getExtensionEventHandlers: () => [],
          applySettings: (settings) => { name = settings.dataBindings[0].dataBindingName; },
          getLiveData: () => [{ name, data }],
          setContext: () => {},
          onExtensionEvent: () => {},
        });
      }
      window.renderer = AplRenderer.default.create({
        content,
        extensionManager,
        view: window.document.getElementById('apl'),
        viewport: { ...viewport, dpi: 160, isRound: false },
        theme: 'dark',
        environment: { agentName: 'CollectRenderTest', agentVersion: '1' },
        utcTime: Date.now(),
        localTimeAdjustment: 0,
        notLoadFonts: true,
        logLevel: 'error',
        developerToolOptions: {
          mappingKey: 'test',
          writeKeys: [],
          includeComponentId: true,
        },
        onSendEvent: (event) => window.aplEvents.push(event.arguments),
        onRunTimeError: (errors) => window.aplErrors.push(...errors),
      });
      await window.renderer.init();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, { ...directive, viewport, summary });
  }

  return { page, render, errors };
}
