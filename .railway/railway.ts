/**
 * Railway Infrastructure as Code for TrueForge hosted mode.
 *
 * One project: app + Postgres + Redis. Plan/apply with:
 *   pnpm install
 *   railway login
 *   railway init --name trueforge   # or: railway link
 *   railway config plan
 *   railway config apply
 *   railway domain                  # public URL for the trueforge service
 *
 * Docs: https://docs.railway.com/infrastructure-as-code
 *
 * Auth is off by default (anyone who can reach the URL is admin). Before
 * sharing a deployment, enable OIDC — see the commented block below and
 * https://trueforge.dev/authentication/overview
 */
import { defineRailway, github, group, postgres, project, redis, service } from 'railway/iac';

export default defineRailway(_ctx => {
  const db = postgres('Postgres');
  const cache = redis('Redis');

  const app = service('trueforge', {
    // Deploys from this repository's default branch. Forks: change owner/repo
    // (and optionally branch) to build your own copy.
    source: github('Xelmar-tech/trueforge', { branch: 'main' }),
    // IaC `build` is a build *command* string (not CaC's builder/dockerfilePath object).
    // Non-root Dockerfile is selected via RAILWAY_DOCKERFILE_PATH below — without it,
    // Railway picks the root Dockerfile (npm install of a published version) and fails
    // without APP_VERSION.
    healthcheck: '/healthz',
    healthcheckTimeout: 300,
    deploy: {
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
      // Above GRACEFUL_TIMEOUT_SECONDS (30) so SIGKILL does not cut off turn drain.
      drainingSeconds: 35,
    },
    env: {
      // From-source image; root Dockerfile is the published npm recipe and needs APP_VERSION.
      RAILWAY_DOCKERFILE_PATH: 'Dockerfile.dev',
      // Postgres + Redis (hosted topology)
      STANDALONE: 'false',
      DATABASE_URL: db.env.DATABASE_URL,
      REDIS_URL: cache.env.REDIS_URL,
      // Expanded by Railway at runtime once a public domain exists on this service.
      PUBLIC_BASE_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',

      // Optional OIDC (login off until these are set). Create matching *shared*
      // variables on the Railway environment, uncomment, then `railway config apply`.
      //
      // OIDC_ISSUER_URL: _ctx.shared.OIDC_ISSUER_URL,
      // OIDC_CLIENT_ID: _ctx.shared.OIDC_CLIENT_ID,
      // OIDC_CLIENT_SECRET: _ctx.shared.OIDC_CLIENT_SECRET,
      // OIDC_USER_REFERENCE_CLAIM: 'email',
      // OIDC_SCOPES: 'openid,profile,email',
      // OIDC_USER_ROLE_CLAIM: 'email',
      // OIDC_ADMIN_ROLE_VALUE: 'you@example.com',
    },
  });

  // Schedule controller: a second service off the same repo/image that runs the
  // periodic control loops (schedule dispatch). Must run as exactly one replica.
  // It talks to Postgres and hands due runs to the app over Railway's private
  // network (SERVER_URL); it needs no public domain or healthcheck.
  const controller = service('trueforge-controller', {
    source: github('Xelmar-tech/trueforge', { branch: 'main' }),
    startCommand: 'node dist/controller-main.js',
    replicas: 1,
    deploy: {
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
      // Single-owner invariant: never run old + new controller at once on redeploy.
      overlapSeconds: 0,
      // Above GRACEFUL_TIMEOUT_SECONDS (30) so SIGKILL does not cut off loop drain.
      drainingSeconds: 35,
    },
    env: {
      RAILWAY_DOCKERFILE_PATH: 'Dockerfile.dev',
      STANDALONE: 'false',
      DATABASE_URL: db.env.DATABASE_URL,
      // `${{trueforge.PORT}}` expands to "" (PORT is injected at runtime, not a service variable),
      // and the image binds 0.0.0.0 while the private network is IPv6-only. The public edge
      // works today; switch back to the private domain once the image binds `::`.
      SERVER_URL: 'https://${{trueforge.RAILWAY_PUBLIC_DOMAIN}}',
    },
  });

  return project('trueforge', {
    resources: [group('TrueForge', [db, cache, app, controller])],
  });
});
