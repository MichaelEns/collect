import {
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
  cryptoProvider,
} from '@peculiar/x509';

export async function createSignedAlexaRequest(url, envelope, certificateUrl) {
  cryptoProvider.set(globalThis.crypto);
  const certificateKeys = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  }, true, ['sign', 'verify']);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=echo-api.amazon.com',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 60 * 60 * 1000),
    signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    keys: certificateKeys,
    extensions: [
      new SubjectAlternativeNameExtension([
        { type: 'dns', value: 'echo-api.amazon.com' },
      ]),
    ],
  });
  const privateKeyData = await crypto.subtle.exportKey(
    'pkcs8', certificateKeys.privateKey);
  const requestSigningKey = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
    false,
    ['sign']);
  const rawBody = JSON.stringify(envelope);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    requestSigningKey,
    new TextEncoder().encode(rawBody));

  return {
    certificatePem: certificate.toString('pem'),
    request: new Request(url, {
      method: 'POST',
      headers: {
        Signature: Buffer.from(signature).toString('base64'),
        SignatureCertChainUrl: certificateUrl,
      },
      body: rawBody,
    }),
  };
}
