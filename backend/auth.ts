import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { emailOTP, magicLink } from "better-auth/plugins";
import { one, now, type Database } from "./db.ts";
import type { Mail } from "./runtime.ts";
export function authOptions(options: {
  database: any;
  db: Database;
  origin: string;
  secret: string;
  publicGoogleSignup?: boolean;
  publicShowcase?: boolean;
  googleId?: string;
  googleSecret?: string;
  sendMail: (m: Mail) => Promise<void>;
}) {
  async function allowed(email: string) {
    return Boolean(
      await one(
        options.db,
        `SELECT 1 FROM ops_assignments WHERE email=? AND state='active'
      UNION SELECT 1 FROM invitations WHERE email=? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>?
      UNION SELECT 1 FROM memberships m JOIN user u ON u.id=m.user_id WHERE u.email=? AND m.state='active' LIMIT 1`,
        [email.toLowerCase(), email.toLowerCase(), now(), email.toLowerCase()],
      ),
    );
  }
  return {
    appName: "TSUNAGU",
    baseURL: options.origin,
    secret: options.secret,
    database: options.database,
    trustedOrigins: [options.origin],
    telemetry: { enabled: false },
    emailAndPassword: { enabled: false },
    // 所属・権限をCookieへコピーしない。権限失効は次のAPIリクエストで反映する。
    session: {
      expiresIn: options.publicShowcase ? 60 * 60 * 2 : 60 * 60 * 24 * 90,
      // 利用のたびに延長せず、ログインから90日後に再認証する。
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    account: { accountLinking: { enabled: false } },
    advanced: {
      useSecureCookies: options.origin.startsWith("https:"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      // 本番の入口はCloudflare。任意のX-Forwarded-Forを信頼しない。
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    socialProviders:
      options.googleId && options.googleSecret
        ? {
            google: {
              clientId: options.googleId,
              clientSecret: options.googleSecret,
            },
          }
        : {},
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!(options.publicGoogleSignup && user.emailVerified) && !(await allowed(user.email)))
              throw new APIError("FORBIDDEN", {
                message: "管理者からの招待が必要です。",
              });
            return { data: { ...user, email: user.email.toLowerCase() } };
          },
        },
      },
    },
    plugins: [
      ...(options.publicShowcase ? [{
        id: "public-showcase",
        endpoints: {
          signInDemo: createAuthEndpoint("/sign-in/demo", {
            method: "POST", requireHeaders: true,
            body: z.object({ email: z.literal("demo@example.com") }),
          }, async (ctx) => {
            if (ctx.headers.get("origin") !== options.origin)
              throw new APIError("FORBIDDEN", { message: "見学画面からログインしてください。" });
            const found = await ctx.context.internalAdapter.findUserByEmail("demo@example.com");
            if (!found || found.user.id !== "showcase-viewer" || !found.user.emailVerified)
              throw new APIError("FORBIDDEN", { message: "見学用データの準備が必要です。" });
            const session = await ctx.context.internalAdapter.createSession(found.user.id);
            if (!session) throw new APIError("INTERNAL_SERVER_ERROR");
            // This account exists only in the physically isolated public showcase.
            // Production MFA and invitation rules are never bypassed.
            await options.db.query("INSERT INTO session_context(session_id,tenant_id,mfa_at) VALUES (?,?,?)", [session.id,"showcase-company",now()]);
            await setSessionCookie(ctx, {session, user: found.user});
            return ctx.json({ok:true});
          }),
        },
      }] : []),
      emailOTP({
        storeOTP: "hashed",
        expiresIn: 300,
        allowedAttempts: 3,
        async sendVerificationOTP({ email, otp, type }) {
          if (type === "sign-in" && (await allowed(email)))
            await options.sendMail({
              to: email,
              subject: "TSUNAGU ログイン確認コード",
              text: `確認コード: ${otp}\n有効期限は5分です。`,
            });
        },
      }),
      magicLink({
        storeToken: "hashed",
        expiresIn: 300,
        async sendMagicLink({ email, url }) {
          if (await allowed(email))
            await options.sendMail({
              to: email,
              subject: "TSUNAGU ログイン",
              text: `次のリンクからログインしてください。有効期限は5分です。\n${url}`,
            });
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}
export function makeAuth(options: Parameters<typeof authOptions>[0]) {
  return betterAuth(authOptions(options));
}
