import { createHmac, timingSafeEqual } from 'node:crypto';

const sessionSecret = cleanEnv('MOBILE_DEVICE_OPERATOR_SESSION_SECRET');
const toolId = cleanEnv('MOBILE_DEVICE_OPERATOR_TOOL_ID') ?? 'mobile-device-operator';
const cookieName = cleanEnv('MOBILE_DEVICE_OPERATOR_SESSION_COOKIE') ?? 'mobile_device_operator_session';
const launchVerifyUrl = cleanEnv('MARKETPLACE_LAUNCH_VERIFY_URL');
const launchVerifySecret = cleanEnv('MARKETPLACE_LAUNCH_VERIFY_SECRET');

if (sessionSecret && Buffer.byteLength(sessionSecret) < 32) {
  throw new Error('MOBILE_DEVICE_OPERATOR_SESSION_SECRET must be at least 32 bytes.');
}

if (!sessionSecret) {
  console.warn('[Mobile Device Operator] MOBILE_DEVICE_OPERATOR_SESSION_SECRET is not set; 2ndBrain launch auth is disabled.');
}

if (launchVerifyUrl) {
  if (!sessionSecret) {
    throw new Error('MOBILE_DEVICE_OPERATOR_SESSION_SECRET is required when MARKETPLACE_LAUNCH_VERIFY_URL is set.');
  }

  if (!launchVerifySecret || Buffer.byteLength(launchVerifySecret) < 32) {
    throw new Error('MARKETPLACE_LAUNCH_VERIFY_SECRET must be at least 32 bytes when MARKETPLACE_LAUNCH_VERIFY_URL is set.');
  }

  try {
    new URL(launchVerifyUrl);
  } catch {
    throw new Error('MARKETPLACE_LAUNCH_VERIFY_URL must be a valid URL.');
  }
} else if (launchVerifySecret) {
  console.warn('[Mobile Device Operator] MARKETPLACE_LAUNCH_VERIFY_SECRET is set but MARKETPLACE_LAUNCH_VERIFY_URL is missing; logout revocation checks are disabled.');
}

function cleanEnv(name) {
  const value = process.env[name]?.trim().replace(/^['"]|['"]$/g, '');

  return value || null;
}

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);

  return Buffer.from(`${normalized}${padding}`, 'base64');
}

function hmac(input) {
  return base64Url(createHmac('sha256', sessionSecret).update(input).digest());
}

function signaturesMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseJsonBase64(part, label) {
  try {
    return JSON.parse(decodeBase64Url(part).toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function normalizeSessionPayload(payload, label = 'Launch session') {
  const exp = Number(payload?.exp);
  const iat = Number(payload?.iat);
  const now = Math.floor(Date.now() / 1000);

  if (payload?.iss !== '2ndBrain.ceo') {
    throw new Error(`${label} issuer is invalid.`);
  }

  if (payload?.tool_id !== toolId) {
    throw new Error(`${label} is for a different workflow tool.`);
  }

  if (!Number.isFinite(exp) || Math.trunc(exp) <= now) {
    throw new Error(`${label} has expired.`);
  }

  if (!Number.isFinite(iat) || Math.trunc(iat) > now + 60) {
    throw new Error(`${label} issued-at timestamp is invalid.`);
  }

  if (typeof payload.user_id !== 'string' || payload.user_id.trim().length === 0) {
    throw new Error(`${label} is missing user_id.`);
  }

  if (typeof payload.install_id !== 'string' || payload.install_id.trim().length === 0) {
    throw new Error(`${label} is missing install_id.`);
  }

  return {
    email: typeof payload.email === 'string' && payload.email.trim() ? payload.email.trim().toLowerCase() : undefined,
    exp: Math.trunc(exp),
    iat: Math.trunc(iat),
    install_id: payload.install_id.trim(),
    iss: '2ndBrain.ceo',
    tool_id: toolId,
    user_id: payload.user_id.trim()
  };
}

function verifyLaunchToken(token) {
  const parts = token.split('.');

  if (parts.length !== 3) {
    throw new Error('Launch token must have three JWT segments.');
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  const header = parseJsonBase64(headerPart, 'Launch token header');

  if (header.alg !== 'HS256') {
    throw new Error('Launch token must use HS256.');
  }

  const expectedSignature = hmac(`${headerPart}.${payloadPart}`);

  if (!signaturesMatch(signaturePart, expectedSignature)) {
    throw new Error('Launch token signature is invalid.');
  }

  return normalizeSessionPayload(parseJsonBase64(payloadPart, 'Launch token payload'), 'Launch token');
}

function signSession(session) {
  const payloadPart = base64Url(JSON.stringify(session));
  const signaturePart = hmac(payloadPart);

  return `${payloadPart}.${signaturePart}`;
}

function verifySessionCookie(value) {
  if (!value) {
    return null;
  }

  const parts = value.split('.');

  if (parts.length !== 2) {
    throw new Error('Launch session cookie is invalid.');
  }

  const [payloadPart, signaturePart] = parts;
  const expectedSignature = hmac(payloadPart);

  if (!signaturesMatch(signaturePart, expectedSignature)) {
    throw new Error('Launch session cookie signature is invalid.');
  }

  return normalizeSessionPayload(parseJsonBase64(payloadPart, 'Launch session cookie'), 'Launch session');
}

function parseCookies(header) {
  const parsed = {};

  for (const pair of String(header ?? '').split(';')) {
    const index = pair.indexOf('=');

    if (index === -1) {
      continue;
    }

    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();

    if (!name) {
      continue;
    }

    parsed[name] = decodeURIComponent(value);
  }

  return parsed;
}

function requestIsSecure(request) {
  const forwardedProto = String(request.headers?.['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  return Boolean(request.secure || request.socket?.encrypted || forwardedProto === 'https');
}

function sessionCookie(request, session) {
  const maxAge = Math.max(0, session.exp - Math.floor(Date.now() / 1000));
  const attributes = [
    `${cookieName}=${encodeURIComponent(signSession(session))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];

  if (requestIsSecure(request)) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

function clearSessionCookie(request) {
  const attributes = [`${cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];

  if (requestIsSecure(request)) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

function requestUrl(request) {
  const host = request.headers?.host ?? 'localhost';

  return new URL(request.originalUrl ?? request.url ?? '/', `http://${host}`);
}

function launchTokenFromUrl(url) {
  return (
    url.searchParams.get('token')?.trim() ||
    url.searchParams.get('launch_token')?.trim() ||
    url.searchParams.get('2ndbrain_launch_token')?.trim() ||
    ''
  );
}

function stripLaunchParams(url) {
  ['token', 'launch_token', '2ndbrain_launch_token'].forEach((name) => {
    url.searchParams.delete(name);
  });

  return `${url.pathname}${url.search}`;
}

function authenticatedSessionFromRequest(request) {
  if (!sessionSecret) {
    return null;
  }

  return verifySessionCookie(parseCookies(request.headers?.cookie)[cookieName]);
}

function wantsJson(request) {
  return String(request.path ?? request.url ?? '').startsWith('/api/') ||
    String(request.headers?.accept ?? '').includes('application/json');
}

function authFailed(request, response, error) {
  const message = error instanceof Error ? error.message : 'Launch this tool from 2ndBrain to continue.';
  response.setHeader('Set-Cookie', clearSessionCookie(request));

  if (wantsJson(request)) {
    return response.status(401).json({
      authenticated: false,
      error: message,
      launchAuthRequired: true
    });
  }

  return response.status(401).send(launchRequiredPage(message));
}

export function launchAuthRequired() {
  return Boolean(sessionSecret);
}

export function launchLivenessRequired() {
  return Boolean(launchVerifyUrl);
}

export async function verifyLaunchSession(session) {
  if (!launchVerifyUrl) {
    return;
  }

  if (!session?.install_id || !Number.isFinite(session.iat)) {
    throw new Error('Launch session is missing 2ndBrain verification data.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let response;

  try {
    response = await fetch(launchVerifyUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${launchVerifySecret}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        installId: session.install_id,
        issuedAt: session.iat,
        toolId: session.tool_id,
        userId: session.user_id
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.active) {
    throw new Error(payload?.error || `2ndBrain launch verification failed with ${response.status}`);
  }
}

export async function requireLaunchSession(request, response, next) {
  if (!sessionSecret) {
    return next();
  }

  const url = requestUrl(request);
  const launchToken = launchTokenFromUrl(url);

  if (launchToken) {
    try {
      const session = verifyLaunchToken(launchToken);
      await verifyLaunchSession(session);

      response.setHeader('Set-Cookie', sessionCookie(request, session));
      request.launchSession = session;

      if (request.method === 'GET' || request.method === 'HEAD') {
        return response.redirect(302, stripLaunchParams(url));
      }

      return next();
    } catch (error) {
      return authFailed(request, response, error);
    }
  }

  try {
    const session = authenticatedSessionFromRequest(request);

    if (!session) {
      throw new Error('Launch this tool from 2ndBrain to continue.');
    }

    await verifyLaunchSession(session);
    request.launchSession = session;

    return next();
  } catch (error) {
    return authFailed(request, response, error);
  }
}

export async function sessionStatus(request, response) {
  if (!sessionSecret) {
    return response.json({
      authenticated: false,
      launchAuthRequired: false
    });
  }

  try {
    const session = authenticatedSessionFromRequest(request);

    if (!session) {
      throw new Error('Launch this tool from 2ndBrain to continue.');
    }

    await verifyLaunchSession(session);

    return response.json({
      authenticated: true,
      email: session.email ?? null,
      exp: session.exp,
      installId: session.install_id,
      launchAuthRequired: true,
      launchLivenessRequired: Boolean(launchVerifyUrl),
      toolId: session.tool_id,
      userId: session.user_id
    });
  } catch (error) {
    response.setHeader('Set-Cookie', clearSessionCookie(request));

    return response.status(401).json({
      authenticated: false,
      error: error instanceof Error ? error.message : 'Launch this tool from 2ndBrain to continue.',
      launchAuthRequired: true
    });
  }
}

export async function requireWebSocketLaunchSession(request) {
  if (!sessionSecret) {
    return { ok: true, session: null };
  }

  try {
    const url = requestUrl(request);
    const launchToken = launchTokenFromUrl(url);
    const session = launchToken ? verifyLaunchToken(launchToken) : authenticatedSessionFromRequest(request);

    if (!session) {
      throw new Error('Launch this tool from 2ndBrain to continue.');
    }

    await verifyLaunchSession(session);

    return { ok: true, session };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Launch this tool from 2ndBrain to continue.',
      ok: false,
      session: null
    };
  }
}

function launchRequiredPage(message = 'Launch this tool from 2ndBrain to continue.') {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>2ndBrain launch required</title>
    <style>
      :root { color: #e5eef8; background: #0b1120; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { display: grid; min-height: 100vh; place-items: center; margin: 0; padding: 24px; }
      main { width: min(100%, 460px); border: 1px solid rgba(148, 163, 184, 0.24); border-radius: 10px; background: #111827; padding: 28px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.32); }
      p { color: #94a3b8; line-height: 1.55; }
      strong { color: #38bdf8; letter-spacing: 0.08em; text-transform: uppercase; }
    </style>
  </head>
  <body>
    <main>
      <strong>2ndBrain launch auth</strong>
      <h1>Launch required</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
