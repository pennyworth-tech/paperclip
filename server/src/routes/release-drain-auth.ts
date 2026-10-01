import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { forbidden, unauthorized } from "../errors.js";

export function assertReleaseDrainIdentity(req: Request): string {
  const ownerId = process.env.BACKLIT_RELEASE_DRAIN_OWNER_ID?.trim();
  const digest = process.env.BACKLIT_RELEASE_DRAIN_TOKEN_SHA256;
  const match = /^Release ([^\s]+)$/.exec(req.header("authorization") ?? "");
  if (!ownerId || !digest || !/^[a-f0-9]{64}$/.test(digest) || !match) {
    throw unauthorized("Release drain identity required");
  }
  const actual = createHash("sha256").update(match[1]).digest();
  if (!timingSafeEqual(actual, Buffer.from(digest, "hex"))) {
    throw unauthorized("Release drain identity required");
  }
  if (req.body?.ownerId !== undefined && req.body.ownerId !== ownerId) {
    throw forbidden("Release drain owner does not match authenticated identity");
  }
  return ownerId;
}
