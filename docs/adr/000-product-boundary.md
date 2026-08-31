# ADR 000: EvalForge product boundary

- Status: accepted
- Date: 2026-08-29

## Decision

EvalForge is a local-first pairwise review workbench for pre-generated AI
responses. A reviewer provides or imports a prompt and candidate responses,
selects a rubric, records a human judgment, and can export the resulting
evidence. The browser is the system of record for this one-device workflow.

The product does not call a model, generate candidate responses, read a user's
mailbox, automatically submit jobs, or provide cloud synchronization. A static
GitHub Pages demo may use clearly labeled synthetic records; sample records are
not mixed into user metrics or exports.

## Why

Keeping generation outside the product makes the review boundary explainable:
the tool evaluates supplied evidence instead of presenting an unverified model
score as a fact. Local storage also keeps the first version easy to run and
auditable without a service account.

## Consequences

- The application must preserve original prompt and candidate content during a
  review.
- Rubric versions and score inputs need to travel with a saved review.
- Storage failure and backup recovery are product behavior, not incidental
  implementation details.
- Multi-user access, server-side retention, authentication, authorization, and
  encryption are outside the current promise and must not be implied by UI
  copy.
- Future work may add a server adapter, but it must keep the domain boundary
  explicit and document the change before changing the public contract.

## Reference policy

We may study established review, annotation, and local-first tools for
interaction patterns and data-model ideas. We implement the behavior in our
own code, use compatible licenses, and do not copy source code, CSS, icons,
screenshots, wording, or proprietary data.
