import session from "express-session";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { Session, SessionData } from "express-session";
import type { Config } from "./config.js";

declare module "express-session" {
  interface SessionData {
    authenticated?: boolean;
    username?: string;
    requestCount?: number;
    dismissedInterstitials?: string[];
  }
}

export function configureSession(app: Express, config: Config): void {
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true },
    }),
  );
}

/**
 * Guards protected routes. A session is valid for exactly
 * `config.expireSessionAfterRequests` authenticated requests after login;
 * the next request past that is treated as expired and redirected to
 * /login?expired=1, so expiry can land mid-flow instead of only at boot.
 * 0 (the default) means never expire.
 */
export function createRequireAuth(config: Config): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.authenticated) {
      res.redirect("/login");
      return;
    }

    const requestCount = (req.session.requestCount ?? 0) + 1;
    const limit = config.expireSessionAfterRequests;

    if (limit > 0 && requestCount > limit) {
      req.session.authenticated = false;
      req.session.requestCount = 0;
      res.redirect("/login?expired=1");
      return;
    }

    req.session.requestCount = requestCount;
    next();
  };
}

type SessionLike = Session & Partial<SessionData>;

export function hasDismissedInterstitial(session: SessionLike, memberId: string): boolean {
  return (session.dismissedInterstitials ?? []).includes(memberId);
}

export function dismissInterstitial(session: SessionLike, memberId: string): void {
  if (!hasDismissedInterstitial(session, memberId)) {
    session.dismissedInterstitials = [...(session.dismissedInterstitials ?? []), memberId];
  }
}
