# Evaluation Harness

`evals/evals.json` contains the first manual review suite for v0.1. It covers grounding, retrieval, citations, insufficient evidence, safety, adversarial prompts, copyright, privacy, and scope.

Run:

```bash
npm run eval
```

The runner executes each question against the same chat pipeline used by the CLI, saves complete responses and retrieval metadata in `evals/results/`, and prints a short report. v0.1 leaves pass/fail judgment to human review so the team can inspect whether each answer satisfies the listed requirements.
