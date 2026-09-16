import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "./metadata";
import { validateMetadata } from "./validate";

test("parses supported front matter metadata", () => {
  const document = parseDocument(`---
id: podcast-142
type: podcast
title: Healthy Boundaries
date: 2025-04-16
participants:
  - Robin
  - Guest Name
canonicality: secondary
rights_status: approved
source_url: https://example.com
---

# Healthy Boundaries
Transcript text.`);

  assert.equal(document.metadata.id, "podcast-142");
  assert.equal(document.metadata.type, "podcast");
  assert.deepEqual(document.metadata.participants, ["Robin", "Guest Name"]);
  assert.equal(document.body, "# Healthy Boundaries\nTranscript text.");
});

test("refuses unapproved rights status", () => {
  const issues = validateMetadata({
    id: "book-chapter-01",
    type: "book",
    title: "Chapter 1",
    canonicality: "primary",
    rights_status: "pending" as "approved"
  });

  assert.equal(issues.length, 1);
  assert.match(issues[0]?.message ?? "", /rights_status is not approved/);
});
