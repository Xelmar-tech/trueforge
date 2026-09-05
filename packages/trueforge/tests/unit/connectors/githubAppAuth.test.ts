import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createInstallationTokenMinter, GithubApiError, githubAppJwt } from '../../../src/connectors/github/appAuth';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('githubAppJwt', () => {
  test('signs an RS256 JWT for the App id with GitHub’s iat/exp window', () => {
    const jwt = githubAppJwt({ app_id: 4242, private_key: PEM }, 1_700_000_000);
    const [header, payload, signature] = jwt.split('.');
    expect(decodeSegment(header ?? '')).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodeSegment(payload ?? '')).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: '4242' });
    const verified = createVerify('RSA-SHA256')
      .update(`${header ?? ''}.${payload ?? ''}`)
      .verify(publicKey, signature ?? '', 'base64url');
    expect(verified).toBe(true);
  });
});

describe('createInstallationTokenMinter', () => {
  function fakeGithub(expiresAt: string) {
    const calls: { method: string; url: string; authorization: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      calls.push({ method: init?.method ?? 'GET', url, authorization: headers.get('authorization') ?? '' });
      if (url.endsWith('/repos/Xelmar-tech/dogfood/installation')) {
        return new Response(JSON.stringify({ id: 77 }), { status: 200 });
      }
      if (url.endsWith('/app/installations/77/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_minted', expires_at: expiresAt }), { status: 201 });
      }
      return new Response('nope', { status: 404 });
    };
    return { calls, fetchImpl };
  }

  test('looks up the installation with the App JWT, mints a token and caches it per repository', async () => {
    let now = Date.parse('2026-09-05T10:00:00.000Z');
    const github = fakeGithub('2026-09-05T11:00:00.000Z');
    const minter = createInstallationTokenMinter({
      credentials: { app_id: 4242, private_key: PEM },
      fetchImpl: github.fetchImpl,
      apiBaseUrl: 'https://gh.example',
      now: () => now,
    });

    expect(await minter.tokenFor('Xelmar-tech/dogfood')).toBe('ghs_minted');
    expect(github.calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'GET https://gh.example/repos/Xelmar-tech/dogfood/installation',
      'POST https://gh.example/app/installations/77/access_tokens',
    ]);
    expect(github.calls[0]?.authorization.startsWith('Bearer eyJ')).toBe(true);

    // Cached while comfortably valid.
    now += 30 * 60 * 1000;
    expect(await minter.tokenFor('Xelmar-tech/dogfood')).toBe('ghs_minted');
    expect(github.calls).toHaveLength(2);

    // Re-minted inside the refresh margin.
    now = Date.parse('2026-09-05T10:59:00.000Z');
    await minter.tokenFor('Xelmar-tech/dogfood');
    expect(github.calls).toHaveLength(4);
  });

  test('surfaces GitHub failures with status and body', async () => {
    const minter = createInstallationTokenMinter({
      credentials: { app_id: 4242, private_key: PEM },
      fetchImpl: async () => new Response('{"message":"Not Found"}', { status: 404 }),
      apiBaseUrl: 'https://gh.example',
    });
    await expect(minter.tokenFor('Xelmar-tech/missing')).rejects.toBeInstanceOf(GithubApiError);
    await expect(minter.tokenFor('Xelmar-tech/missing')).rejects.toMatchObject({ status: 404 });
  });
});
