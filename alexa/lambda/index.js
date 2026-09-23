'use strict';

const Alexa = require('ask-sdk-core');
const fetch = require('node-fetch');
const {
  DoorablesError,
  DoorablesService,
  figureCodesSpeech,
  lookupSpeech,
  needSpeech,
  normaliseFamilyCode,
  resolvePackage,
} = require('./doorables');

const service = new DoorablesService({ fetch });

function isIntent(handlerInput, name) {
  return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
    Alexa.getIntentName(handlerInput.requestEnvelope) === name;
}

function rawSlot(handlerInput, name) {
  const slots = handlerInput.requestEnvelope.request.intent.slots || {};
  return slots[name] && slots[name].value;
}

function resolvedSlot(handlerInput, name) {
  const slots = handlerInput.requestEnvelope.request.intent.slots || {};
  const slot = slots[name];
  const authorities = slot && slot.resolutions && slot.resolutions.resolutionsPerAuthority;
  const values = authorities && authorities[0] && authorities[0].values;
  return values && values[0] ? values[0].value.name : rawSlot(handlerInput, name);
}

async function attributes(handlerInput) {
  return handlerInput.attributesManager.getPersistentAttributes();
}

async function linkedCode(handlerInput) {
  const stored = await attributes(handlerInput);
  return stored.familyCode || null;
}

function response(handlerInput, speech, reprompt) {
  const builder = handlerInput.responseBuilder.speak(speech);
  if (reprompt) builder.reprompt(reprompt);
  return builder.getResponse();
}

function packageResolution(handlerInput) {
  return resolvePackage(resolvedSlot(handlerInput, 'package'));
}

function rememberPackageQuestion(
  handlerInput, resolution, operation, capsuleCode, figure) {
  const session = handlerInput.attributesManager.getSessionAttributes();
  session.pendingPackage = {
    kind: resolution.kind,
    choices: resolution.choices,
    operation,
    capsuleCode,
    figure,
  };
  handlerInput.attributesManager.setSessionAttributes(session);
}

async function answerNeed(handlerInput, familyCode, packageInfo) {
  const progress = await service.progress(familyCode);
  const result = await service.countNeeded(packageInfo, progress);
  return response(handlerInput, needSpeech(result));
}

async function answerLookup(handlerInput, familyCode, packageInfo, capsuleCode) {
  const progress = await service.progress(familyCode);
  let result;
  try {
    result = await service.lookup(packageInfo, capsuleCode, progress);
  } catch (error) {
    if (error instanceof DoorablesError && error.code === 'invalid-capsule-code') {
      return response(handlerInput,
        'I did not understand that package code. Please say the letter and number again.');
    }
    throw error;
  }
  return response(handlerInput, lookupSpeech(result));
}

async function answerFigureCodes(handlerInput, familyCode, packageInfo, figure) {
  await service.progress(familyCode);
  const result = await service.findFigureCodes(packageInfo, figure);
  return response(handlerInput, figureCodesSpeech(result));
}

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  async handle(handlerInput) {
    const code = await linkedCode(handlerInput);
    const speech = code
      ? 'Joe\'s collection is linked. Ask how many red Death Star figures Joe needs, ' +
        'or ask what is in gray Death Star code I 8.'
      : 'First link Joe\'s collection. Say, use sharing code, followed by the four words.';
    return response(handlerInput, speech, 'What would you like to know?');
  },
};

const LinkCollectionIntentHandler = {
  canHandle(handlerInput) {
    return isIntent(handlerInput, 'LinkCollectionIntent');
  },
  async handle(handlerInput) {
    const familyCode = normaliseFamilyCode(rawSlot(handlerInput, 'familyCode'));
    if (!familyCode) {
      return response(handlerInput,
        'A sharing code has four words. Please say, use sharing code, followed by all four.',
        'What are the four words?');
    }
    try {
      await service.progress(familyCode);
    } catch (error) {
      if (error instanceof DoorablesError && error.code === 'invalid-code') {
        return response(handlerInput,
          'That sharing code was not recognized. Please check the four words and try again.',
          'What are the four words?');
      }
      throw error;
    }

    const stored = await attributes(handlerInput);
    stored.familyCode = familyCode;
    handlerInput.attributesManager.setPersistentAttributes(stored);
    await handlerInput.attributesManager.savePersistentAttributes();
    return response(handlerInput,
      'Joe\'s collection is linked. I will not repeat the sharing code.');
  },
};

const NeedCountIntentHandler = {
  canHandle(handlerInput) {
    return isIntent(handlerInput, 'NeedCountIntent');
  },
  async handle(handlerInput) {
    const code = await linkedCode(handlerInput);
    if (!code) {
      return response(handlerInput,
        'Joe\'s collection is not linked yet. Say, use sharing code, followed by the four words.');
    }
    const resolution = packageResolution(handlerInput);
    if (resolution.status === 'ambiguous') {
      rememberPackageQuestion(handlerInput, resolution, 'need');
      return response(handlerInput, resolution.speech, resolution.speech);
    }
    if (resolution.status !== 'ok') {
      return response(handlerInput,
        'I did not recognize that package. Try red Death Star, gray Death Star, ' +
        'or a blue, green, or purple Toy Story backpack.');
    }
    return answerNeed(handlerInput, code, resolution.packageInfo);
  },
};

const CodeLookupIntentHandler = {
  canHandle(handlerInput) {
    return isIntent(handlerInput, 'CodeLookupIntent');
  },
  async handle(handlerInput) {
    const code = await linkedCode(handlerInput);
    if (!code) {
      return response(handlerInput,
        'Joe\'s collection is not linked yet. Say, use sharing code, followed by the four words.');
    }
    const resolution = packageResolution(handlerInput);
    if (resolution.status === 'ambiguous') {
      rememberPackageQuestion(
        handlerInput, resolution, 'lookup', resolvedSlot(handlerInput, 'capsuleCode'));
      return response(handlerInput, resolution.speech, resolution.speech);
    }
    if (resolution.status !== 'ok') {
      return response(handlerInput,
        'I did not recognize that package. Include its color and package shape.');
    }
    return answerLookup(
      handlerInput, code, resolution.packageInfo, resolvedSlot(handlerInput, 'capsuleCode'));
  },
};

const FigureCodeIntentHandler = {
  canHandle(handlerInput) {
    return isIntent(handlerInput, 'FigureCodeIntent');
  },
  async handle(handlerInput) {
    const code = await linkedCode(handlerInput);
    if (!code) {
      return response(handlerInput,
        'Joe\'s collection is not linked yet. Say, use sharing code, followed by the four words.');
    }
    const resolution = packageResolution(handlerInput);
    const figure = resolvedSlot(handlerInput, 'figure');
    if (resolution.status === 'ambiguous') {
      rememberPackageQuestion(
        handlerInput, resolution, 'figure-codes', undefined, figure);
      return response(handlerInput, resolution.speech, resolution.speech);
    }
    if (resolution.status !== 'ok') {
      return response(handlerInput,
        'I did not recognize that package. Include its color and package shape.');
    }
    return answerFigureCodes(handlerInput, code, resolution.packageInfo, figure);
  },
};

const PackageClarificationIntentHandler = {
  canHandle(handlerInput) {
    return isIntent(handlerInput, 'PackageClarificationIntent');
  },
  async handle(handlerInput) {
    const session = handlerInput.attributesManager.getSessionAttributes();
    const pending = session.pendingPackage;
    if (!pending) {
      return response(handlerInput,
        'Please ask the whole question again, including the package color.');
    }

    const rawColor = resolvedSlot(handlerInput, 'color');
    const color = String(rawColor || '').toLowerCase().replace('grey', 'gray');
    if (!pending.choices.includes(color)) {
      const prompt = `Please choose ${pending.choices.join(', or ')}.`;
      return response(handlerInput, prompt, prompt);
    }
    const resolution = resolvePackage(`${color} ${pending.kind}`);
    if (resolution.status !== 'ok') {
      return response(handlerInput,
        'I could not match that color. Please ask the whole question again.');
    }

    delete session.pendingPackage;
    handlerInput.attributesManager.setSessionAttributes(session);
    const code = await linkedCode(handlerInput);
    if (!code) {
      return response(handlerInput,
        'Joe\'s collection is not linked yet. Say, use sharing code, followed by the four words.');
    }
    if (pending.operation === 'lookup') {
      return answerLookup(
        handlerInput, code, resolution.packageInfo, pending.capsuleCode);
    }
    if (pending.operation === 'figure-codes') {
      return answerFigureCodes(
        handlerInput, code, resolution.packageInfo, pending.figure);
    }
    return answerNeed(handlerInput, code, resolution.packageInfo);
  },
};

const UnlinkCollectionIntentHandler = {
  canHandle(handlerInput) {
    return isIntent(handlerInput, 'UnlinkCollectionIntent');
  },
  async handle(handlerInput) {
    handlerInput.attributesManager.setPersistentAttributes({});
    await handlerInput.attributesManager.savePersistentAttributes();
    return response(handlerInput, 'Joe\'s collection is unlinked from this Alexa account.');
  },
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return isIntent(handlerInput, 'AMAZON.HelpIntent');
  },
  handle(handlerInput) {
    return response(handlerInput,
      'You can ask how many red Death Star figures Joe needs, or what is in gray ' +
      'Death Star code I 8, or what code Queen Amidala is in. ' +
      'Toy Story backpacks need a color: blue, green, or purple.',
      'What would you like to know?');
  },
};

const CancelAndStopIntentHandler = {
  canHandle(handlerInput) {
    return isIntent(handlerInput, 'AMAZON.CancelIntent') ||
      isIntent(handlerInput, 'AMAZON.StopIntent');
  },
  handle(handlerInput) {
    return response(handlerInput, 'Goodbye.');
  },
};

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return isIntent(handlerInput, 'AMAZON.FallbackIntent');
  },
  handle(handlerInput) {
    return response(handlerInput,
      'I can count what Joe needs or look up a package code. Include the package color.',
      'Try asking how many red Death Star figures Joe needs.');
  },
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle() {
    return {};
  },
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    const code = error instanceof DoorablesError ? error.code : 'internal';
    console.error(`Doorables request failed: ${code}`);
    if (code === 'invalid-code') {
      return response(handlerInput,
        'The saved sharing code no longer works. Please link Joe\'s collection again.');
    }
    if (code === 'rate-limited') {
      return response(handlerInput, 'There were too many requests just now. Please try again soon.');
    }
    return response(handlerInput,
      'I could not reach Joe\'s collection just now. Please try again in a moment.');
  },
};

const builder = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    LinkCollectionIntentHandler,
    NeedCountIntentHandler,
    CodeLookupIntentHandler,
    FigureCodeIntentHandler,
    PackageClarificationIntentHandler,
    UnlinkCollectionIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler)
  .addErrorHandlers(ErrorHandler);

if (process.env.DYNAMODB_PERSISTENCE_TABLE_NAME) {
  const { DynamoDbPersistenceAdapter } =
    require('ask-sdk-dynamodb-persistence-adapter');
  builder.withPersistenceAdapter(new DynamoDbPersistenceAdapter({
    tableName: process.env.DYNAMODB_PERSISTENCE_TABLE_NAME,
    createTable: false,
  }));
}

exports.handler = builder.lambda();
