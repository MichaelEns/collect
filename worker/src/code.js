/*
 * The family code.
 *
 * There is no account and no password, because the person using this app is
 * six. Instead one code identifies a family's collection, and holding it is
 * what grants access. It is read aloud, written on a sticky note and typed
 * with a thumb, so it has to survive all three.
 *
 * Words, not characters. "moon-ewok-brave-comet" can be dictated across a
 * room; "gK7x2Qp9" cannot. Four words from this list give 40^4 ... which is
 * far too few, so the list is deliberately large:
 *
 *   256 words, four of them = 256^4 = 2^32 = 4.3 billion codes.
 *
 * With server-side rate limiting that is comfortably out of reach for guessing,
 * while staying short enough to read out. Words that sound alike when spoken
 * (bear/bare) or look alike when typed are kept out on purpose.
 */

export const WORDS = [
  'astro', 'atom', 'aurora', 'badger', 'balloon', 'bamboo', 'banana', 'banjo',
  'basket', 'beacon', 'beetle', 'bell', 'berry', 'bison', 'blossom', 'bluejay',
  'bobcat', 'bonfire', 'boulder', 'brave', 'breeze', 'bridge', 'bronze', 'bubble',
  'buffalo', 'bugle', 'bunny', 'butter', 'cactus', 'camel', 'candle', 'canyon',
  'cargo', 'carrot', 'castle', 'cedar', 'cello', 'cherry', 'chestnut', 'chimney',
  'cinnamon', 'circus', 'clever', 'cliff', 'clover', 'cobra', 'cocoa', 'comet',
  'compass', 'copper', 'coral', 'cosmic', 'cottage', 'coyote', 'crater', 'crayon',
  'cricket', 'crimson', 'crystal', 'cyclone', 'daisy', 'dandy', 'dazzle', 'delta',
  'diamond', 'dingo', 'dolphin', 'domino', 'donut', 'dragon', 'dreamer', 'drummer',
  'dusty', 'eagle', 'echo', 'ember', 'emerald', 'engine', 'ewok', 'falcon',
  'feather', 'fennec', 'fiddle', 'firefly', 'flamingo', 'flint', 'flute', 'forest',
  'fossil', 'fountain', 'foxglove', 'freckle', 'frost', 'galaxy', 'garden', 'gecko',
  'gentle', 'geyser', 'ginger', 'glacier', 'glimmer', 'gopher', 'granite', 'grape',
  'gravity', 'griffin', 'guitar', 'gumdrop', 'gusto', 'hammock', 'harbour', 'harvest',
  'hazel', 'hedgehog', 'helix', 'hermit', 'hickory', 'hollow', 'honey', 'hopper',
  'hornet', 'hummus', 'hunter', 'iceberg', 'igloo', 'indigo', 'iris', 'ivory',
  'jaguar', 'jasmine', 'jelly', 'jigsaw', 'jingle', 'juniper', 'jupiter', 'kangaroo',
  'kayak', 'kettle', 'kingdom', 'kitten', 'koala', 'lagoon', 'lantern', 'lava',
  'lemon', 'leopard', 'lighthouse', 'lilac', 'lively', 'lizard', 'llama', 'lobster',
  'lotus', 'lucky', 'lunar', 'lynx', 'magnet', 'magnolia', 'mammoth', 'mango',
  'maple', 'marble', 'marmot', 'meadow', 'melody', 'meteor', 'mitten', 'monsoon',
  'moose', 'moss', 'mountain', 'muffin', 'mulberry', 'mustang', 'nebula', 'nectar',
  'needle', 'nimble', 'noodle', 'nugget', 'nutmeg', 'oasis', 'ocelot', 'octopus',
  'olive', 'onyx', 'opal', 'orbit', 'orchid', 'otter', 'outpost', 'oyster',
  'paddle', 'panda', 'pangolin', 'parsnip', 'peach', 'pebble', 'pelican', 'penguin',
  'pepper', 'phoenix', 'piano', 'pickle', 'pilot', 'pinecone', 'pistachio', 'planet',
  'plum', 'polar', 'pony', 'poppy', 'possum', 'prairie', 'pretzel', 'puffin',
  'pumpkin', 'puzzle', 'quartz', 'quilt', 'quiver', 'rabbit', 'raccoon', 'radish',
  'rainbow', 'raven', 'reef', 'rhubarb', 'ribbon', 'rocket', 'rooster', 'rosemary',
  'ruby', 'rustic', 'saffron', 'salmon', 'sandal', 'sapphire', 'satellite', 'scooter',
  'seagull', 'sequoia', 'shadow', 'shamrock', 'sherbet', 'shiny', 'shrimp', 'silver',
  'skipper', 'sleigh', 'smooth', 'sneaker', 'snowdrop', 'sparrow', 'spruce', 'squid',
];

/** Four words joined by hyphens, e.g. "comet-ewok-brave-moon". */
export function makeCode(random = crypto) {
  const picks = new Uint32Array(4);
  random.getRandomValues(picks);
  return Array.from(picks, (n) => WORDS[n % WORDS.length]).join('-');
}

/**
 * Accepts what a person actually types: stray spaces, capitals, and the
 * underscores or spaces they used instead of hyphens.
 *
 * Returns null if it is not a plausible code, so a typo is rejected up front
 * rather than silently starting a brand new empty collection — which would
 * look exactly like sync having lost everything.
 */
export function normaliseCode(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.toLowerCase().trim().split(/[^a-z]+/).filter(Boolean);
  if (parts.length !== 4) return null;
  if (!parts.every((p) => WORDS.includes(p))) return null;
  return parts.join('-');
}
