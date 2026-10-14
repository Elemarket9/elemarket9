import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint, APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { getSql } from '../../../../../lib/db';
import { getPortalConfiguration } from '../../../../../lib/security/portal-policy.mjs';
import { requireSameOrigin } from './security.mjs';
import { verifyExecutiveLogin } from './core.server.mjs';

/**
 * A dedicated Better Auth session minting endpoint. The application NEVER issues
 * sessions from a face/PIN claim supplied by browser JavaScript. Face liveness,
 * and passphrase are verified on the server first.
 */
export const executiveBiometric = () => ({
  id: 'eide-executive-biometric',
  endpoints: {
    executiveFaceSignIn: createAuthEndpoint('/executive/face-sign-in', {
      method: 'POST',
      requireHeaders: true,
      body: z.object({
        challengeId: z.string().uuid(),
        pin: z.string().min(12).max(128),
        frames: z.array(z.string().min(400).max(500_000)).length(3),
      }),
    }, async (ctx) => {
      try {
        if (!ctx.request) throw new Error('Missing request');
        const conf = getPortalConfiguration();
        if (!conf) throw new Error('Missing executive portal');
        requireSameOrigin(ctx.request,conf.hosts.executive);
        // No session created until all independent checks pass.
        const {userId} = await verifyExecutiveLogin(ctx.request,ctx.body);
        const user = await ctx.context.internalAdapter.findUserById(userId);
        if (!user || user.id !== userId) throw new Error('Executive identity not found');
        const session = await ctx.context.internalAdapter.createSession(userId);
        if (!session) throw new Error('Unable to establish executive session');
        try {
          const sql = await getSql();
          await sql.query(`insert into executive_face_session_assurance(session_id,user_id,method)
            values($1,$2,'face-passphrase')`,[session.id,userId]);
          await setSessionCookie(ctx,{session,user});
          return ctx.json({ok:true});
        } catch (error) {
          await ctx.context.internalAdapter.deleteSession(session.token);
          throw error;
        }
      } catch {
        // Uniform error; never return whether face, passphrase or possession failed.
        throw new APIError('UNAUTHORIZED',{message:'Executive authentication rejected'});
      }
    }),
  },
}) satisfies BetterAuthPlugin;
