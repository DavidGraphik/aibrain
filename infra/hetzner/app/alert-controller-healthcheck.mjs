#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function positiveInteger(name, fallback, maximum) {
  const raw = process.env[name]?.trim() || String(fallback);
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error(`${name} is invalid.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error(`${name} is invalid.`);
  return value;
}

function fail() {
  process.exitCode = 1;
}

try {
  const statusFile = process.env.AIBRAIN_ALERT_STATUS_FILE?.trim()
    || "/tmp/aibrain-alert-controller-status.json";
  if (!path.isAbsolute(statusFile) || statusFile.includes("\0")) throw new Error("status path is invalid");
  const metadata = lstatSync(statusFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0 || metadata.size < 2 || metadata.size > 64 * 1024) {
    fail();
  } else {
    const status = JSON.parse(readFileSync(statusFile, "utf8"));
    const evaluatedAt = Date.parse(status?.evaluatedAt);
    const oldestCreatedAt = status?.delivery?.oldestCreatedAt === null
      ? null
      : Date.parse(status?.delivery?.oldestCreatedAt);
    const now = Date.now();
    const maximumStatusAgeMs = positiveInteger("AIBRAIN_ALERT_HEALTH_MAX_AGE_MS", 180_000, 3_600_000);
    const pendingWarningAgeMs = positiveInteger("AIBRAIN_ALERT_PENDING_WARN_AGE_MS", 900_000, 7 * 24 * 60 * 60 * 1_000);
    const validCounts = ["pending", "retryable", "deferred", "exhausted"]
      .every((key) => Number.isSafeInteger(status?.delivery?.[key]) && status.delivery[key] >= 0);
    if (status?.operation !== "alerts" || !Number.isFinite(evaluatedAt)
      || evaluatedAt > now || now - evaluatedAt > maximumStatusAgeMs || !validCounts
      || (oldestCreatedAt !== null && (!Number.isFinite(oldestCreatedAt) || oldestCreatedAt > now))) {
      fail();
    } else if (status.delivery.exhausted > 0
      || (oldestCreatedAt !== null && now - oldestCreatedAt > pendingWarningAgeMs)) {
      process.stdout.write(`${JSON.stringify({
        controller: "ready",
        delivery: "degraded",
        pending: status.delivery.pending,
        exhausted: status.delivery.exhausted,
      })}\n`);
    }
  }
} catch {
  fail();
}
