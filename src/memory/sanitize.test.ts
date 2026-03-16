/**
 * Content Sanitization Tests
 */

import { describe, it, expect } from "bun:test";
import { sanitize, sanitizeObservationFields } from "./sanitize.js";

describe("sanitize", () => {
  it("should return unchanged text with no secrets", () => {
    const result = sanitize(
      "This is a normal observation about database migrations.",
    );
    expect(result.text).toBe(
      "This is a normal observation about database migrations.",
    );
    expect(result.redactedCount).toBe(0);
  });

  it("should redact AWS access keys", () => {
    const result = sanitize("Found key AKIAIOSFODNN7EXAMPLE in config");
    expect(result.text).toContain("[REDACTED:AWS_KEY]");
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.redactedCount).toBe(1);
  });

  it("should redact AWS secret access keys", () => {
    const result = sanitize(
      "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    );
    expect(result.text).toContain("[REDACTED]");
    expect(result.text).not.toContain("wJalrXUtnFEMI");
    expect(result.redactedCount).toBe(1);
  });

  it("should redact Bearer tokens", () => {
    const result = sanitize(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw",
    );
    expect(result.text).toContain("Bearer [REDACTED]");
    expect(result.redactedCount).toBeGreaterThanOrEqual(1);
  });

  it("should redact JWT tokens", () => {
    const result = sanitize(
      "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456",
    );
    expect(result.text).toContain("[REDACTED:JWT]");
    expect(result.redactedCount).toBeGreaterThanOrEqual(1);
  });

  it("should redact private keys", () => {
    const pem = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7
-----END PRIVATE KEY-----`;
    const result = sanitize(`Found: ${pem}`);
    expect(result.text).toContain("[REDACTED:PRIVATE_KEY]");
    expect(result.text).not.toContain("MIIEvgIBADA");
    expect(result.redactedCount).toBe(1);
  });

  it("should redact RSA private keys", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7
-----END RSA PRIVATE KEY-----`;
    const result = sanitize(`Key: ${pem}`);
    expect(result.text).toContain("[REDACTED:PRIVATE_KEY]");
    expect(result.redactedCount).toBe(1);
  });

  it("should redact connection strings with credentials", () => {
    const result = sanitize(
      "DATABASE_URL=postgres://admin:s3cretP4ss@db.example.com:5432/mydb",
    );
    expect(result.text).toContain("[REDACTED:CONNECTION_STRING]");
    expect(result.text).not.toContain("s3cretP4ss");
    expect(result.redactedCount).toBe(1);
  });

  it("should redact MongoDB connection strings", () => {
    const result = sanitize("mongodb://user:password123@mongo.example.com/db");
    expect(result.text).toContain("[REDACTED:CONNECTION_STRING]");
    expect(result.redactedCount).toBe(1);
  });

  it("should redact password fields", () => {
    const result = sanitize("Config: password=my_super_secret_pass123");
    expect(result.text).toContain("password=[REDACTED]");
    expect(result.text).not.toContain("my_super_secret_pass123");
    expect(result.redactedCount).toBe(1);
  });

  it("should redact api_key fields", () => {
    const result = sanitize("api_key=sk_live_abcdefghijklmnop1234");
    expect(result.text).toContain("[REDACTED:CREDENTIAL]");
    expect(result.redactedCount).toBe(1);
  });

  it("should redact GitHub tokens", () => {
    const result = sanitize(
      "Using token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl",
    );
    expect(result.text).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(result.text).not.toContain("ghp_ABCDEF");
    expect(result.redactedCount).toBe(1);
  });

  it("should redact Slack tokens", () => {
    const result = sanitize("SLACK_TOKEN=xoxb-1234567890-abcdefghij");
    expect(result.text).toContain("[REDACTED:SLACK_TOKEN]");
    expect(result.redactedCount).toBeGreaterThanOrEqual(1);
  });

  it("should redact npm tokens", () => {
    const result = sanitize(
      "Found npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij in logs",
    );
    expect(result.text).toContain("[REDACTED:NPM_TOKEN]");
    expect(result.redactedCount).toBeGreaterThanOrEqual(1);
  });

  it("should redact multiple secrets in one text", () => {
    const text = "Found AKIAIOSFODNN7EXAMPLE and password=secret123 in config";
    const result = sanitize(text);
    expect(result.redactedCount).toBeGreaterThanOrEqual(2);
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.text).not.toContain("secret123");
  });

  it("should preserve surrounding text", () => {
    const result = sanitize("Before AKIAIOSFODNN7EXAMPLE After");
    expect(result.text).toMatch(/^Before .+ After$/);
  });
});

describe("sanitizeObservationFields", () => {
  it("should sanitize both title and content", () => {
    const result = sanitizeObservationFields({
      title: "Found key AKIAIOSFODNN7EXAMPLE",
      content: "The password=supersecret was in the config",
    });

    expect(result.title).toContain("[REDACTED:AWS_KEY]");
    expect(result.content).toContain("password=[REDACTED]");
    expect(result.redactedCount).toBe(2);
  });

  it("should return zero count when nothing to redact", () => {
    const result = sanitizeObservationFields({
      title: "Normal title",
      content: "Normal content about code patterns",
    });

    expect(result.title).toBe("Normal title");
    expect(result.content).toBe("Normal content about code patterns");
    expect(result.redactedCount).toBe(0);
  });
});
