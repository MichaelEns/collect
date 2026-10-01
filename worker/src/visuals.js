import dashboardDocument from '../../alexa/apl/dashboard.json' with { type: 'json' };
import setDocument from '../../alexa/apl/set.json' with { type: 'json' };
import { collectionImageUrl } from './alexa-image.js';

function initials(name) {
  const words = String(name || '').match(/[A-Za-z0-9]+/g) || [];
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function supportsApl(envelope) {
  const interfaces = envelope.context && envelope.context.System &&
    envelope.context.System.device &&
    envelope.context.System.device.supportedInterfaces;
  return Boolean(interfaces && interfaces['Alexa.Presentation.APL']);
}

export function renderDocument(document, data, token) {
  return {
    type: 'Alexa.Presentation.APL.RenderDocument',
    token,
    document,
    datasources: {
      payload: data,
    },
  };
}

export async function dashboardDirective(queryService, progress, access) {
  const sets = await queryService.collectionSets(progress);
  const found = sets.reduce((total, set) => total + set.found, 0);
  const total = sets.reduce((sum, set) => sum + set.total, 0);
  return renderDocument(dashboardDocument, {
    title: access.name,
    subtitle: `${found} of ${total} found · ${access.role === 'viewer' ? 'View only' : 'Tap a set to open it'}`,
    sets: sets.map((set) => ({
      ...set,
      complete: set.total > 0 && set.found === set.total,
    })),
  }, 'collection-dashboard');
}

export async function setDirective(queryService, progress, access, setId, env) {
  const sets = await queryService.collectionSets(progress);
  const set = sets.find((item) => item.id === setId);
  if (!set) return dashboardDirective(queryService, progress, access);
  return renderDocument(setDocument, {
    title: set.name,
    subtitle: `${set.found} of ${set.total} found · ${access.name}` +
      (access.role === 'viewer' ? ' · View only' : ''),
    setId: set.id,
    canEdit: access.role !== 'viewer',
    figures: await Promise.all(set.figures.map(async (figure) => ({
      ...figure,
      initials: initials(figure.name),
      image: await collectionImageUrl(
        env,
        access.collectionCode,
        set.id,
        figure.id,
      ),
    }))),
  }, `collection-set-${set.id}`);
}
