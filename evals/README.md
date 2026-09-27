# Evaluation Harness

`evals/evals.json` contains the first manual review suite for v0.1. It covers grounding, retrieval, citations, insufficient evidence, safety, adversarial prompts, copyright, privacy, and scope.

The private feedback dashboard can export curated eval candidates. An administrator must mark each candidate and write a sanitized test question and expected behavior. Review the downloaded JSON before merging selected cases into `evals/evals.json`; raw reviewer conversations and reported answers should not be copied into the repository.

Run:

```bash
npm run eval
```

The runner executes each question against the same chat pipeline used by the CLI, saves complete responses and retrieval metadata in `evals/results/`, and prints a short report. v0.1 leaves pass/fail judgment to human review so the team can inspect whether each answer satisfies the listed requirements.
