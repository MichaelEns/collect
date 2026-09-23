'use strict';

const FAMILY_WORDS = new Set(require('./family-words.json'));

const DEFAULT_SYNC_ENDPOINT =
  'https://collect-sync.michaelens.workers.dev/v1/collection';
const DEFAULT_DATA_BASE = 'https://michaelens.github.io/collect/sets';
const CACHE_MS = 15 * 60 * 1000;

const PACKAGES = [
  {
    label: 'gray Death Star',
    setIds: ['sw-galaxy-peek-s1'],
    aliases: ['gray death star', 'grey death star', 'galaxy peek series 1'],
  },
  {
    label: 'red Death Star',
    setIds: ['sw-galaxy-peek-s2'],
    aliases: ['red death star', 'galaxy peek series 2'],
  },
  {
    label: 'blue Cargo Drop',
    setIds: ['sw-galaxy-peek-s3'],
    aliases: ['blue cargo drop', 'galaxy peek series 3'],
  },
  {
    label: 'orange Cargo Drop',
    setIds: ['sw-galaxy-peek-s4'],
    aliases: ['orange cargo drop', 'galaxy peek series 4'],
  },
  {
    label: 'gray A T A T',
    setIds: ['sw-galaxy-peek-s5'],
    aliases: ['gray at at', 'grey at at', 'galaxy peek series 5'],
  },
  {
    label: 'blue Toy Story backpack',
    setIds: ['ts-small-stars-s1'],
    aliases: ['blue toy story backpack', 'blue backpack', 'small stars series 1'],
  },
  {
    label: 'green Toy Story backpack',
    setIds: ['ts-small-stars-s2'],
    aliases: ['green toy story backpack', 'green backpack', 'small stars series 2'],
  },
  {
    label: 'purple Toy Story backpack',
    setIds: ['ts-small-stars-s3'],
    aliases: ['purple toy story backpack', 'purple backpack', 'small stars series 3'],
  },
  {
    label: 'Toy Story blind bag',
    setIds: ['ts-rerelease'],
    aliases: ['toy story blind bag', 'toy story series 1'],
  },
  {
    label: 'Ticket to Fun capsule',
    setIds: ['disney-ticket-to-fun'],
    aliases: ['ticket to fun capsule', 'ticket to fun', 'series 16'],
  },
];

class DoorablesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DoorablesError';
    this.code = code;
  }
}

function normaliseFamilyCode(raw) {
  if (typeof raw !== 'string') return null;
  const tokens = raw.toLowerCase().match(/[a-z]+/g) || [];
  const memo = new Map();
  const find = (tokenIndex, wordIndex) => {
    const key = `${tokenIndex}:${wordIndex}`;
    if (memo.has(key)) return memo.get(key);
    if (wordIndex === 4) return tokenIndex === tokens.length ? [] : null;

    let joined = '';
    for (let end = tokenIndex; end < tokens.length; end += 1) {
      joined += tokens[end];
      if (!FAMILY_WORDS.has(joined)) continue;
      const rest = find(end + 1, wordIndex + 1);
      if (rest) {
        const result = [joined, ...rest];
        memo.set(key, result);
        return result;
      }
    }
    memo.set(key, null);
    return null;
  };
  const words = find(0, 0);
  return words ? words.join('-') : null;
}

function normalisePackage(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/\bgrey\b/g, 'gray')
    .replace(/\bdeathstar\b/g, 'death star')
    .replace(/\bback\s+packs?\b/g, 'backpack')
    .replace(/\bbackpacks\b/g, 'backpack')
    .replace(/\ba\s+t\s+a\s+t\b/g, 'at at')
    .replace(/\bat[\s-]*at\b/g, 'at at')
    .replace(/\b(packages?|packs?|guys?|figures?|characters?|doorables?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function resolvePackage(raw) {
  const wanted = normalisePackage(raw);
  if (!wanted) return { status: 'unknown' };

  for (const packageInfo of PACKAGES) {
    if (packageInfo.aliases.some((alias) => normalisePackage(alias) === wanted)) {
      return { status: 'ok', packageInfo };
    }
  }

  if (wanted.includes('toy story') && wanted.includes('backpack')) {
    return {
      status: 'ambiguous',
      kind: 'Toy Story backpack',
      choices: ['blue', 'green', 'purple'],
      speech: 'Which Toy Story backpack: blue, green, or purple?',
    };
  }
  if (wanted.includes('death star')) {
    return {
      status: 'ambiguous',
      kind: 'Death Star',
      choices: ['gray', 'red'],
      speech: 'Which Death Star: gray or red?',
    };
  }
  if (wanted.includes('cargo drop')) {
    return {
      status: 'ambiguous',
      kind: 'Cargo Drop',
      choices: ['blue', 'orange'],
      speech: 'Which Cargo Drop: blue or orange?',
    };
  }

  const containing = PACKAGES.filter((packageInfo) =>
    packageInfo.aliases.some((alias) => {
      const normalisedAlias = normalisePackage(alias);
      return wanted.includes(normalisedAlias) || normalisedAlias.includes(wanted);
    }));
  return containing.length === 1
    ? { status: 'ok', packageInfo: containing[0] }
    : { status: 'unknown' };
}

const DIGITS = new Map([
  ['zero', 0], ['oh', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4],
  ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9],
]);
const SMALL_NUMBERS = new Map([
  ['ten', 10], ['eleven', 11], ['twelve', 12], ['thirteen', 13],
  ['fourteen', 14], ['fifteen', 15], ['sixteen', 16], ['seventeen', 17],
  ['eighteen', 18], ['nineteen', 19],
]);
const TENS = new Map([
  ['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50],
  ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90],
]);
const LETTERS = new Map([
  ['a', 'A'], ['ay', 'A'], ['bee', 'B'], ['b', 'B'], ['see', 'C'],
  ['sea', 'C'], ['c', 'C'], ['dee', 'D'], ['d', 'D'], ['e', 'E'],
  ['ee', 'E'], ['eff', 'F'], ['f', 'F'], ['gee', 'G'], ['g', 'G'],
  ['aitch', 'H'], ['h', 'H'], ['eye', 'I'], ['i', 'I'], ['jay', 'J'],
  ['j', 'J'], ['kay', 'K'], ['k', 'K'], ['el', 'L'], ['l', 'L'],
  ['em', 'M'], ['m', 'M'], ['en', 'N'], ['n', 'N'], ['o', 'O'],
  ['pee', 'P'], ['p', 'P'], ['cue', 'Q'], ['queue', 'Q'], ['q', 'Q'],
  ['are', 'R'], ['r', 'R'], ['ess', 'S'], ['s', 'S'], ['tee', 'T'],
  ['t', 'T'], ['you', 'U'], ['u', 'U'], ['vee', 'V'], ['v', 'V'],
  ['w', 'W'], ['ex', 'X'], ['x', 'X'], ['why', 'Y'], ['y', 'Y'],
  ['zee', 'Z'], ['zed', 'Z'], ['z', 'Z'],
]);

function numberWords(words) {
  if (!words.length) return '';
  if (words.every((word) => DIGITS.has(word))) {
    return words.map((word) => DIGITS.get(word)).join('');
  }

  let current = 0;
  for (const word of words) {
    if (DIGITS.has(word)) current += DIGITS.get(word);
    else if (SMALL_NUMBERS.has(word)) current += SMALL_NUMBERS.get(word);
    else if (TENS.has(word)) current += TENS.get(word);
    else if (word === 'hundred') current = Math.max(current, 1) * 100;
    else return '';
  }
  return String(current);
}

function compactCapsuleCode(raw, leadingOhIsLetter) {
  const tokens = String(raw || '')
    .toLowerCase()
    .replace(/\bdouble\s+you\b/g, 'w')
    .match(/[a-z]+|\d+/g) || [];
  const explicitNumber = tokens[0] === 'number';
  const useful = tokens.filter((token) =>
    !['code', 'letter', 'number', 'hash'].includes(token));
  let compact = '';
  let words = [];
  const flushNumbers = () => {
    compact += numberWords(words);
    words = [];
  };

  for (let index = 0; index < useful.length; index += 1) {
    const token = useful[index];
    if (/^\d+$/.test(token)) {
      flushNumbers();
      compact += token;
    } else if (index === 0 && token === 'oh' && leadingOhIsLetter && !explicitNumber) {
      flushNumbers();
      compact += 'O';
    } else if (DIGITS.has(token) || SMALL_NUMBERS.has(token) ||
               TENS.has(token) || token === 'hundred') {
      words.push(token);
    } else if (LETTERS.has(token)) {
      flushNumbers();
      compact += LETTERS.get(token);
    } else {
      return null;
    }
  }
  flushNumbers();
  return codeKey(compact);
}

function capsuleCodeCandidates(raw) {
  const letterO = compactCapsuleCode(raw, true);
  const zero = compactCapsuleCode(raw, false);
  return [...new Set([letterO, zero].filter(Boolean))];
}

function normaliseCapsuleCode(raw) {
  return capsuleCodeCandidates(raw)[0] || null;
}

function codeKey(raw) {
  const compact = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = compact.match(/^([A-Z]*)(\d+)$/);
  if (!match) return null;
  return match[1] + String(Number(match[2]));
}

function humanList(items) {
  if (items.length < 2) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function formatCodeForSpeech(code) {
  return String(code).replace(/^([A-Z]+)(\d+)$/, '$1 $2');
}

function figureName(set, id) {
  const figure = set.figures.find((item) => item.id === id);
  return figure ? figure.name : id.replace(/-/g, ' ');
}

function normaliseFigureName(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isOwned(progress, setId, figureId) {
  return Boolean(progress[setId] && progress[setId][figureId] &&
    progress[setId][figureId].have === true);
}

class DoorablesService {
  constructor(options = {}) {
    const runtimeEnv = typeof process !== 'undefined' && process.env ? process.env : {};
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new TypeError('DoorablesService requires a fetch implementation.');
    }
    this.syncEndpoint = options.syncEndpoint || runtimeEnv.COLLECT_SYNC_ENDPOINT ||
      DEFAULT_SYNC_ENDPOINT;
    this.dataBase = (options.dataBase || runtimeEnv.COLLECT_DATA_BASE ||
      DEFAULT_DATA_BASE).replace(/\/+$/, '');
    this.cache = new Map();
  }

  async fetchJson(url, options = {}, cache = false) {
    const cached = this.cache.get(url);
    if (cache && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

    let response;
    try {
      response = await this.fetch(url, { timeout: 5000, ...options });
    } catch {
      throw new DoorablesError('unavailable', 'The collection service could not be reached.');
    }
    if (!response.ok) {
      const code = response.status === 401 ? 'invalid-code'
        : response.status === 429 ? 'rate-limited' : 'unavailable';
      throw new DoorablesError(code, `The collection service returned ${response.status}.`);
    }
    let value;
    try {
      value = await response.json();
    } catch {
      throw new DoorablesError('unavailable', 'The collection service returned invalid data.');
    }
    if (cache) this.cache.set(url, { at: Date.now(), value });
    return value;
  }

  async progress(familyCode) {
    const code = normaliseFamilyCode(familyCode);
    if (!code) throw new DoorablesError('invalid-code', 'A sharing code has four words.');
    const collection = await this.fetchJson(this.syncEndpoint, {
      headers: { 'X-Family-Code': code },
    });
    if (!collection.progress || typeof collection.progress !== 'object') {
      throw new DoorablesError('unavailable', 'The collection response had no progress.');
    }
    return collection.progress;
  }

  async loadSets(packageInfo) {
    const index = await this.fetchJson(`${this.dataBase}/index.json`, {}, true);
    return Promise.all(packageInfo.setIds.map(async (setId) => {
      const metadata = index.find((item) => item.id === setId);
      if (!metadata) throw new DoorablesError('unavailable', `Set ${setId} is unavailable.`);
      const set = await this.fetchJson(`${this.dataBase}/${metadata.file}`, {}, true);
      return { metadata, set };
    }));
  }

  async countNeeded(packageInfo, progress) {
    const sets = await this.loadSets(packageInfo);
    let total = 0;
    let missing = 0;
    for (const { set } of sets) {
      total += set.figures.length;
      missing += set.figures.filter((figure) =>
        !isOwned(progress, set.id, figure.id)).length;
    }
    return { label: packageInfo.label, total, missing };
  }

  async lookup(packageInfo, rawCode, progress) {
    const candidates = capsuleCodeCandidates(rawCode);
    if (!candidates.length) {
      throw new DoorablesError('invalid-capsule-code', 'That package code was unclear.');
    }
    const sets = await this.loadSets(packageInfo);
    const matches = new Map(candidates.map((candidate) => [candidate, []]));

    for (const { metadata, set } of sets) {
      if (!set.codeFile) continue;
      const codeData = await this.fetchJson(`${this.dataBase}/${set.codeFile}`, {}, true);
      for (const candidate of candidates) {
        let agreed = null;
        let disputed = null;
        for (const [sourceCode, ids] of Object.entries(codeData.codes || {})) {
          if (codeKey(sourceCode) === candidate) agreed = ids;
        }
        for (const [sourceCode, variants] of Object.entries(codeData.disputed || {})) {
          if (codeKey(sourceCode) === candidate) disputed = variants;
        }
        const variants = disputed || (agreed ? [agreed] : []);
        if (!variants.length) continue;
        matches.get(candidate).push({
          setName: metadata.name,
          disputed: Boolean(disputed),
          variants: variants.map((ids) => ({
            names: ids.map((id) => figureName(set, id)),
            missingNames: ids.filter((id) => !isOwned(progress, set.id, id))
              .map((id) => figureName(set, id)),
            total: ids.length,
            missing: ids.filter((id) => !isOwned(progress, set.id, id)).length,
          })),
        });
      }
    }

    const found = [...matches.entries()].filter(([, entries]) => entries.length);
    if (found.length > 1) {
      return {
        code: found[0][0],
        ambiguousCodes: found.map(([code]) => code),
        label: packageInfo.label,
        entries: [],
      };
    }
    const [code, entries] = found[0] || [candidates[0], []];
    return { code, label: packageInfo.label, entries };
  }

  async findFigureCodes(packageInfo, rawFigure) {
    const wanted = normaliseFigureName(rawFigure);
    if (!wanted) return { status: 'unknown', label: packageInfo.label };
    const sets = await this.loadSets(packageInfo);
    const candidates = [];

    for (const { metadata, set } of sets) {
      for (const figure of set.figures) {
        const name = normaliseFigureName(figure.name);
        const id = normaliseFigureName(figure.id);
        if (name === wanted || id === wanted ||
            name.split(' ').includes(wanted) || name.endsWith(` ${wanted}`)) {
          candidates.push({ metadata, set, figure });
        }
      }
    }
    if (candidates.length !== 1) {
      return {
        status: candidates.length ? 'ambiguous' : 'unknown',
        label: packageInfo.label,
        names: candidates.map(({ figure }) => figure.name),
      };
    }

    const { metadata, set, figure } = candidates[0];
    if (!set.codeFile) {
      return {
        status: 'ok',
        label: packageInfo.label,
        setName: metadata.name,
        figure: figure.name,
        agreed: [],
        disputed: [],
      };
    }
    const codeData = await this.fetchJson(`${this.dataBase}/${set.codeFile}`, {}, true);
    const agreed = Object.entries(codeData.codes || {})
      .filter(([, ids]) => ids.includes(figure.id))
      .map(([code]) => code);
    const disputed = Object.entries(codeData.disputed || {})
      .filter(([, variants]) => variants.some((ids) => ids.includes(figure.id)))
      .map(([code]) => code);
    return {
      status: 'ok',
      label: packageInfo.label,
      setName: metadata.name,
      figure: figure.name,
      agreed,
      disputed,
    };
  }
}

function needSpeech(result) {
  if (result.missing === 0) {
    return `Joe has every ${result.label} figure, all ${result.total}.`;
  }
  return `Joe needs ${result.missing} of the ${result.total} ${result.label} figures.`;
}

function lookupSpeech(result) {
  const spokenCode = formatCodeForSpeech(result.code);
  if (result.ambiguousCodes) {
    const choices = result.ambiguousCodes.map(formatCodeForSpeech);
    return `That could mean ${humanList(choices)} for the ${result.label}. ` +
      `Say letter ${choices[0]}, or say number ${choices[choices.length - 1]}.`;
  }
  if (!result.entries.length) {
    return `I could not find code ${spokenCode} for the ${result.label}.`;
  }

  const parts = [];
  for (const entry of result.entries) {
    const prefix = result.entries.length > 1 ? `${entry.setName}: ` : '';
    if (entry.disputed) {
      const reports = entry.variants.map((variant, index) =>
        `${index === 0 ? 'one list' : 'another list'} says ${humanList(variant.names)}`);
      const uniqueNames = new Set(entry.variants.flatMap((variant) => variant.names));
      const missingNames = new Set(entry.variants.flatMap((variant) => variant.missingNames));
      parts.push(`${prefix}sources disagree; ${reports.join('; ')}. ` +
        `Across those possibilities, Joe still needs ${missingNames.size} of the ` +
        `${uniqueNames.size} possible figures.`);
      continue;
    }
    const variant = entry.variants[0];
    const ownership = variant.missing === 0
      ? `Joe has all ${variant.total} of them.`
      : variant.missing === variant.total
        ? `Joe still needs all ${variant.total}.`
        : `Joe still needs ${variant.missing} of those ${variant.total} figures.`;
    parts.push(`${prefix}${humanList(variant.names)}. ${ownership}`);
  }
  return `${result.label} code ${spokenCode} contains ${parts.join(' ')}`;
}

function figureCodesSpeech(result) {
  if (result.status === 'ambiguous') {
    return `I found more than one match: ${humanList(result.names)}. Please use the full name.`;
  }
  if (result.status !== 'ok') {
    return `I could not find that figure in the ${result.label}.`;
  }
  if (!result.agreed.length && !result.disputed.length) {
    return `I do not have any recorded ${result.label} codes for ${result.figure}.`;
  }

  const parts = [];
  if (result.agreed.length) {
    parts.push(`${result.figure} is in ${result.label} ` +
      `${result.agreed.length === 1 ? 'code' : 'codes'} ` +
      `${humanList(result.agreed.map(formatCodeForSpeech))}.`);
  }
  if (result.disputed.length) {
    parts.push(`Collector sources disagree about ${result.disputed.length === 1 ? 'code' : 'codes'} ` +
      `${humanList(result.disputed.map(formatCodeForSpeech))}, but at least one report ` +
      `also puts ${result.figure} there.`);
  }
  return parts.join(' ');
}

module.exports = {
  DoorablesError,
  DoorablesService,
  PACKAGES,
  capsuleCodeCandidates,
  codeKey,
  figureCodesSpeech,
  lookupSpeech,
  needSpeech,
  normaliseCapsuleCode,
  normaliseFamilyCode,
  normaliseFigureName,
  normalisePackage,
  resolvePackage,
};
