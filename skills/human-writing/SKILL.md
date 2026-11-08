---
name: human-writing
description: Draft, edit, humanize, or audit durable prose so it sounds like a specific person rather than generic AI output while preserving meaning, evidence, and voice. Use for emails, DMs, social posts, articles, landing-page copy, reports, documentation, bios, proposals, and other text meant to be sent, saved, published, or committed; trigger on requests to write, rewrite, humanize, de-slop, remove AI tells, match a voice, or review whether text sounds machine-written.
---

# Human writing

Produce writing with a point of view, a real audience, and an evidence boundary. Remove machine-like patterns without replacing the author's voice with flat professional prose.

Apply this skill to durable writing artifacts. Do not turn routine chat replies or progress updates into a formal editing exercise.

## Choose the mode

- **Draft:** Write from a brief. Establish the reader, purpose, evidence, and voice before drafting.
- **Edit:** Make the minimum effective changes to supplied prose. Preserve the author's structure unless it blocks the piece.
- **Audit:** Identify exact spans and named patterns without rewriting or guessing whether AI authored the text.
- **Voice calibration:** Infer a usable voice profile from the user's samples, then draft or edit against it.

If the user asks for a finished artifact, return the artifact first. Explain edits only when requested or when a material ambiguity remains.

## Evidence lock

Before changing prose, lock:

- names, numbers, dates, URLs, citations, quotations, and technical claims;
- explicit uncertainty, qualifications, obligations, and promises;
- the user's stance and intended reader action;
- deliberate wording the user says must remain.

Never invent specificity to sound human. If a strong sentence needs a missing mechanism, example, metric, or source, ask for it or state the plain supported claim. Clearly label hypotheticals.

Instructions about the artifact are not part of the artifact. Follow them without printing them back.

## Calibrate the voice

When samples exist, note internally:

- sentence and paragraph length;
- vocabulary and contractions;
- directness, humor, slang, profanity, and uncertainty;
- punctuation, transitions, openings, and endings;
- quirks the writer repeats and phrases they would never use.

The sample outranks generic style rules unless it conflicts with truth, safety, the requested format, or an explicit instruction. Without a sample, default to direct, specific, lightly conversational prose that trusts the reader.

## Draft and edit loop

1. **Name the job.** Identify who will read it and what they should understand, feel, or do. Ask one short question only when the missing answer materially changes the text.
2. **Write for meaning first.** Do not self-censor into blandness while drafting.
3. **Diagnose clusters.** Load [resources/references/pattern-catalog.md](resources/references/pattern-catalog.md). Flag patterns only when they repeat, carry no information, or clash with the author's voice.
4. **Edit surgically.** Cut filler and formula, strengthen verbs, replace vague claims with supported mechanisms, and vary cadence where it has become mechanical.
5. **Check the format.** Load [resources/references/format-routing.md](resources/references/format-routing.md) for the target medium.
6. **Read aloud mentally.** Fix choppiness, uniform rhythm, polished transition stacks, and new formulas introduced by the edit.
7. **Run the final gate.** Confirm that every claim remains supported and the result still sounds like the same person.

For files or long drafts, optionally run:

```bash
python3 <skill-directory>/scripts/prose_signals.py path/to/draft.txt
```

Treat its output as review leads, never as proof of authorship or quality.

## Editing priorities

Apply in this order:

1. factual preservation and promise boundaries;
2. clear point and reader action;
3. voice preservation;
4. removal of filler, puffery, and unsupported abstraction;
5. cadence and structural variety;
6. punctuation and formatting cleanup.

Do not enforce arbitrary bans. A single em dash, triplet, fragment, formal word, or passive sentence can be the right choice. Repetition without purpose is the signal.

## Audit output

For audit-only requests, use a compact table or bullets containing:

- exact span;
- pattern name;
- why it weakens this piece;
- smallest plausible fix.

Do not score how human the author is, claim that AI wrote it, or rewrite unless asked. Detectors and word lists cannot establish authorship.

## Final gate

- Every source claim, qualifier, and useful detail survived.
- No new fact, anecdote, metric, citation, feature, or promise appeared.
- The opening starts the piece instead of announcing it.
- Each paragraph adds a claim, example, mechanism, consequence, image, or decision.
- Repeated sentence shapes and rhetorical templates were broken where mechanical.
- Strong fragments, contrasts, humor, and quirks were preserved when they sounded earned.
- The ending lands on a concrete thought or action instead of a recap or generic uplift.
- Formatting matches the destination.
- The result sounds like this writer addressing this reader, not a universal house style.

## Source synthesis

This skill synthesizes complementary ideas from `soundshuman` by aashaexo, `no-ai-slop` by Peter Yang, `anti-slop` by elithrar, `slopbeth` by ehmo, `stop-slop` by Hardik Pandya, and selected structural checks from `anti-ai-slop-writing` by jalaalrd. It intentionally excludes detector-evasion promises, rigid scoring, and universal punctuation bans.
